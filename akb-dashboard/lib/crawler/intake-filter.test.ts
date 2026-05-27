// Ship 2 — intake-filter pure tests.

import { describe, it, expect } from "vitest";
import {
  evaluateIntakeCandidate,
  filterIntakeCandidates,
  isSingleFamily,
  normalizeAddressKey,
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
    agentName: null,
    agentPhone: null,
    agentEmail: null,
    brokerageName: null,
    ...over,
  };
}

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
  // No DOM lower floor (removed 2026-05-26): fire on EVERY active band
  // listing regardless of age — a fresh-but-distress listing is exactly the
  // first-low-offer target. NOW = 2026-05-25.
  it("accepts a very-new listing (DOM 3d → no lower floor)", () => {
    const threeDays = new Date("2026-05-22T00:00:00Z").toISOString();
    const r = evaluateIntakeCandidate(cand({ listedDate: threeDays }), NOW);
    expect(r.reasons).not.toContain("listed_date_too_new");
    expect(r.accept).toBe(true);
  });
  it("accepts a 5d listing (no lower floor)", () => {
    const fiveDays = new Date("2026-05-20T00:00:00Z").toISOString();
    expect(evaluateIntakeCandidate(cand({ listedDate: fiveDays }), NOW).accept).toBe(true);
  });
  it("passes a long-DOM listing (30d)", () => {
    const thirtyDays = new Date("2026-04-25T00:00:00Z").toISOString();
    expect(evaluateIntakeCandidate(cand({ listedDate: thirtyDays }), NOW).accept).toBe(true);
  });
  it("passes a very old listing when no DISTRESS_DOM_CAP set (144d)", () => {
    expect(evaluateIntakeCandidate(cand({ listedDate: old }), NOW).accept).toBe(true);
  });
  it("accepts a missing listed date when no DISTRESS_DOM_CAP set", () => {
    const r = evaluateIntakeCandidate(cand({ listedDate: null }), NOW);
    expect(r.reasons).not.toContain("listed_date_missing");
    expect(r.accept).toBe(true);
  });
  it("accepts a band listing with NO distress signal (distress gate removed)", () => {
    // First-contact fires on every active band listing — the 65% script is
    // the door-opener; price-reduction is a downstream re-engagement trigger.
    expect(evaluateIntakeCandidate(cand(), NOW).accept).toBe(true);
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
