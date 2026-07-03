// Ship 2 — intake-filter pure tests.

import { describe, it, expect } from "vitest";
import {
  evaluateIntakeCandidate,
  filterIntakeCandidates,
  isSingleFamily,
  normalizeAddressKey,
  distressSourcingReasons,
  EXCLUDED_STATES,
  type IntakeCandidate,
} from "./intake-filter";

const NOW = new Date("2026-05-25T00:00:00Z");
const recent = new Date("2026-04-01T00:00:00Z").toISOString(); // ~54d ago
const old = new Date("2026-01-01T00:00:00Z").toISOString(); // ~144d ago

function cand(over: Partial<IntakeCandidate> = {}): IntakeCandidate {
  return {
    sourceId: "attom:1",
    address: "123 Main St",
    city: "San Antonio",
    state: "TX",
    zip: "78201",
    propertyType: "SFR",
    beds: 3,
    listPrice: 150000,
    listedDate: recent,
    // Distress-passing default (operator 2026-06-22: distress sourcing is now
    // ON by default). Base-rule tests use this so they exercise SFR/beds/price/
    // state, not the distress gate; the distress/DOM tests override it.
    daysOnMarket: 120,
    agentName: null,
    agentPhone: null,
    agentEmail: null,
    brokerageName: null,
    ...over,
  };
}

describe("distressSourcingReasons (Phase-1 distress sourcing, operator 2026-06-22)", () => {
  const ON = { requireDistress: true, domMark: 90, domFloor: null };
  it("rejects a fresh, full-price listing — no distress signal", () => {
    expect(distressSourcingReasons({ daysOnMarket: 10, priceReduced: false }, ON, NOW)).toContain("no_distress_signal");
  });
  it("sources an aged listing (DOM ≥ mark) on aging alone", () => {
    expect(distressSourcingReasons({ daysOnMarket: 110, priceReduced: false }, ON, NOW)).toEqual([]);
  });
  it("sources a price-cut listing even when fresh", () => {
    expect(distressSourcingReasons({ daysOnMarket: 5, priceReduced: true }, ON, NOW)).toEqual([]);
  });
  it("DOM just below the 90 mark is NOT sourced (aligns with A1's ≥90 distress)", () => {
    expect(distressSourcingReasons({ daysOnMarket: 86, priceReduced: false }, ON, NOW)).toContain("no_distress_signal");
  });
  it("requireDistress off → sources everything (legacy fire-on-all)", () => {
    expect(distressSourcingReasons({ daysOnMarket: 1, priceReduced: false }, { requireDistress: false, domMark: 90, domFloor: null }, NOW)).toEqual([]);
  });
  it("falls back to listedDate when daysOnMarket is absent", () => {
    expect(distressSourcingReasons({ listedDate: old, priceReduced: false }, ON, NOW)).toEqual([]); // ~144d ago
  });
});

describe("isSingleFamily", () => {
  it("accepts SFR variants", () => {
    expect(isSingleFamily("SFR")).toBe(true);
    expect(isSingleFamily("Single Family Residence")).toBe(true);
    expect(isSingleFamily("single-family")).toBe(true);
    expect(isSingleFamily("Detached")).toBe(true);
  });
  it("rejects non-SFR", () => {
    expect(isSingleFamily("Condominium")).toBe(false);
    expect(isSingleFamily("Townhouse")).toBe(false);
    expect(isSingleFamily("Duplex")).toBe(false);
    expect(isSingleFamily("Vacant Land")).toBe(false);
    expect(isSingleFamily(null)).toBe(false);
  });
});

describe("evaluateIntakeCandidate", () => {
  it("accepts a fully-qualifying candidate", () => {
    expect(evaluateIntakeCandidate(cand(), NOW)).toEqual({ accept: true, reasons: [] });
  });

  it("rejects non-SFR", () => {
    expect(evaluateIntakeCandidate(cand({ propertyType: "Condo" }), NOW).reasons).toContain("not_sfr");
  });
  it("rejects beds < 2", () => {
    expect(evaluateIntakeCandidate(cand({ beds: 1 }), NOW).reasons).toContain("beds_below_min");
  });
  it("rejects price below band ($20K floor)", () => {
    expect(evaluateIntakeCandidate(cand({ listPrice: 15000 }), NOW).reasons).toContain("list_price_out_of_band");
  });
  it("rejects price above band", () => {
    expect(evaluateIntakeCandidate(cand({ listPrice: 500000 }), NOW).reasons).toContain("list_price_out_of_band");
  });
  it("accepts price at band edges ($20K / $400K)", () => {
    expect(evaluateIntakeCandidate(cand({ listPrice: 20000 }), NOW).accept).toBe(true);
    expect(evaluateIntakeCandidate(cand({ listPrice: 400000 }), NOW).accept).toBe(true);
  });
  it("accepts a sub-$75K listing (floor lowered to $20K)", () => {
    expect(evaluateIntakeCandidate(cand({ listPrice: 45000 }), NOW).accept).toBe(true);
  });
  it("flags missing list price (the ATTOM snapshot blocker)", () => {
    expect(evaluateIntakeCandidate(cand({ listPrice: null }), NOW).reasons).toContain("list_price_missing");
  });
  // Phase-1 distress sourcing is ON by default (operator 2026-06-22): source
  // distress, not market-rate active listings. Fresh + full-price is rejected;
  // aged (DOM ≥ 90) or price-cut is sourced. NOW = 2026-05-25.
  it("rejects a fresh, full-price listing — no distress signal (default-on)", () => {
    const r = evaluateIntakeCandidate(cand({ daysOnMarket: 3 }), NOW);
    expect(r.reasons).toContain("no_distress_signal");
    expect(r.accept).toBe(false);
  });
  it("rejects an aged-but-sub-90 listing (86d) — aligns with A1's ≥90", () => {
    expect(evaluateIntakeCandidate(cand({ daysOnMarket: 86 }), NOW).reasons).toContain("no_distress_signal");
  });
  it("sources an aged listing (DOM ≥ 90)", () => {
    expect(evaluateIntakeCandidate(cand({ daysOnMarket: 120 }), NOW).accept).toBe(true);
  });
  it("sources a price-cut listing even when fresh", () => {
    expect(evaluateIntakeCandidate(cand({ daysOnMarket: 5, priceReduced: true }), NOW).accept).toBe(true);
  });
  it("rejects a missing-DOM, full-price listing — no distress signal", () => {
    const r = evaluateIntakeCandidate(cand({ daysOnMarket: null, listedDate: null }), NOW);
    expect(r.reasons).toContain("no_distress_signal");
  });
  it("rejects excluded states", () => {
    for (const s of ["IL", "MO", "SC", "NC", "OK", "ND"]) {
      expect(evaluateIntakeCandidate(cand({ state: s }), NOW).reasons).toContain("excluded_state");
    }
  });
  it("accepts non-excluded states (TX, TN)", () => {
    expect(evaluateIntakeCandidate(cand({ state: "TX" }), NOW).accept).toBe(true);
    expect(evaluateIntakeCandidate(cand({ state: "TN" }), NOW).accept).toBe(true);
  });
  it("flags missing state", () => {
    expect(evaluateIntakeCandidate(cand({ state: null }), NOW).reasons).toContain("state_missing");
  });
  it("collects ALL failing reasons (not short-circuit)", () => {
    const r = evaluateIntakeCandidate(
      cand({ propertyType: "Condo", beds: 1, listPrice: 10000, state: "IL" }),
      NOW,
    );
    expect(r.accept).toBe(false);
    expect(r.reasons).toEqual(
      expect.arrayContaining(["not_sfr", "beds_below_min", "list_price_out_of_band", "excluded_state"]),
    );
  });
});

describe("filterIntakeCandidates", () => {
  it("partitions accepted vs rejected with reasons", () => {
    const r = filterIntakeCandidates([cand(), cand({ state: "IL" }), cand({ beds: 1 })], NOW);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0].reasons.length).toBeGreaterThan(0);
  });
});

describe("normalizeAddressKey", () => {
  it("normalizes for dedup", () => {
    expect(normalizeAddressKey("123 Main St.")).toBe("123 main st");
    expect(normalizeAddressKey("123  MAIN  ST")).toBe("123 main st");
    expect(normalizeAddressKey(null)).toBe("");
  });
});

describe("EXCLUDED_STATES", () => {
  it("is exactly the 6 wholesale-restrictive states", () => {
    expect([...EXCLUDED_STATES].sort()).toEqual(["IL", "MO", "NC", "ND", "OK", "SC"]);
  });
});

describe("evaluateIntakeCandidate — priceable-market gate (opt-in)", () => {
  const seeded = new Set(["48227"]);

  it("default (no priceability opts) does NOT apply the gate — backward compatible", () => {
    // SA TX passes when the gate is off (existing behavior).
    expect(evaluateIntakeCandidate(cand(), NOW).accept).toBe(true);
  });

  it("requirePriceable rejects TX San Antonio (no sourced arv_pct_max)", () => {
    const r = evaluateIntakeCandidate(cand(), NOW, { seededZips: seeded, requirePriceable: true });
    expect(r.accept).toBe(false);
    expect(r.reasons).toContain("market_not_priceable");
  });

  it("requirePriceable accepts Detroit 48227 (sourced + seeded)", () => {
    const r = evaluateIntakeCandidate(
      cand({ state: "MI", city: "Detroit", zip: "48227" }),
      NOW,
      { seededZips: seeded, requirePriceable: true },
    );
    expect(r.accept).toBe(true);
  });

  it("requirePriceable rejects a Detroit ZIP with no seeded median", () => {
    const r = evaluateIntakeCandidate(
      cand({ state: "MI", city: "Detroit", zip: "48228" }),
      NOW,
      { seededZips: seeded, requirePriceable: true },
    );
    expect(r.accept).toBe(false);
    expect(r.reasons).toContain("market_not_priceable");
  });
});

// ── Sqft cross-check (data armor, 2026-07-03 Tiger Flowers regression) ──
import {
  extractScrapedSqft,
  crossCheckSqft,
  SQFT_MISMATCH_TOLERANCE,
} from "./intake-filter";

describe("extractScrapedSqft — building sqft from portal text, lot sizes excluded", () => {
  it("takes the headline building sqft (Tiger Flowers: page said 983)", () => {
    expect(extractScrapedSqft("2 beds · 1.5 baths · 983 sq ft · Built 1938")).toBe(983);
    expect(extractScrapedSqft("1,966 Sq. Ft. single family home")).toBe(1_966);
    expect(extractScrapedSqft("about 1450 sqft of living space")).toBe(1_450);
  });
  it("skips LOT/acre mentions and finds the building figure", () => {
    expect(extractScrapedSqft("9,017 sq ft lot · 983 sq ft")).toBe(983);
    expect(extractScrapedSqft("Lot: 7,405 sq ft — home is 1,200 square feet")).toBe(1_200);
  });
  it("null when the page states nothing usable", () => {
    expect(extractScrapedSqft(null)).toBeNull();
    expect(extractScrapedSqft("charming bungalow on a large lot")).toBeNull();
    expect(extractScrapedSqft("55 sq ft storage shed")).toBeNull(); // below band
  });
});

describe("crossCheckSqft — the basement-double-count detector", () => {
  it("REGRESSION 1989 Tiger Flowers: source 1,966 vs page 983 → mismatch, ratio 2.0", () => {
    const r = crossCheckSqft(1_966, 983);
    expect(r.mismatch).toBe(true);
    expect(r.ratio).toBeCloseTo(2.0, 5);
  });
  it("portal rounding within tolerance passes", () => {
    expect(crossCheckSqft(1_000, 950).mismatch).toBe(false);
    expect(crossCheckSqft(1_395, 1_400).mismatch).toBe(false);
  });
  it("deflated source (source ≪ page) also mismatches — wrong is wrong", () => {
    expect(crossCheckSqft(700, 1_000).mismatch).toBe(true);
  });
  it("fails OPEN when either side is missing/invalid", () => {
    expect(crossCheckSqft(null, 983).mismatch).toBe(false);
    expect(crossCheckSqft(1_966, null).mismatch).toBe(false);
    expect(crossCheckSqft(0, 983).mismatch).toBe(false);
  });
  it("tolerance boundary: exactly ±25% passes, beyond flags", () => {
    expect(crossCheckSqft(1_250, 1_000, SQFT_MISMATCH_TOLERANCE).mismatch).toBe(false);
    expect(crossCheckSqft(1_260, 1_000, SQFT_MISMATCH_TOLERANCE).mismatch).toBe(true);
  });
});
