import { describe, it, expect } from "vitest";
import { isActionableMarket, isPriceableMarket, isFreshnessPriceableMarket } from "./actionable";

describe("isActionableMarket", () => {
  it("San Antonio TX is actionable (price via ARV, can assign)", () => {
    expect(isActionableMarket({ state: "TX", city: "San Antonio", zip: "78201" })).toEqual({ actionable: true, reason: null });
  });

  it("Detroit MI is actionable", () => {
    expect(isActionableMarket({ state: "MI", city: "Detroit", zip: "48201" }).actionable).toBe(true);
  });

  it("Memphis TN is actionable again (unpaused 2026-07-23; assignability enforced at EMD/contract)", () => {
    const r = isActionableMarket({ state: "TN", city: "Memphis", zip: "38109" });
    expect(r).toEqual({ actionable: true, reason: null });
  });

  it("Memphis by zip is actionable even if city is blank", () => {
    expect(isActionableMarket({ state: "TN", city: null, zip: "38114" }).actionable).toBe(true);
  });

  it("other TN markets are actionable too", () => {
    expect(isActionableMarket({ state: "TN", city: "Nashville", zip: "37011" }).actionable).toBe(true);
  });

  it("HARD-excludes wholesale-restrictive states", () => {
    for (const s of ["IL", "MO", "SC", "NC", "OK", "ND"]) {
      const r = isActionableMarket({ state: s, city: "X", zip: "00000" });
      expect(r.actionable).toBe(false);
      expect(r.reason).toBe("wholesale_restricted_state");
    }
  });

  it("rejects a missing state", () => {
    expect(isActionableMarket({ state: null }).reason).toBe("state_missing");
  });
});

describe("isPriceableMarket — opener-priceable (national buy-box) AND seeded ZIP", () => {
  const seeded = new Set(["48227", "46218", "78201"]);

  it("Detroit 48227 (configured+verified + seeded) is PRICEABLE", () => {
    expect(isPriceableMarket({ state: "MI", city: "Detroit", zip: "48227" }, seeded)).toEqual({ actionable: true, reason: null });
  });

  it("CAST-WIDE: an unconfigured DISCLOSURE metro (Indianapolis IN) that is seeded is PRICEABLE off the national opener default", () => {
    // No IN market is configured; the opener prices it at the 0.70 national
    // default (IN is disclosure + non-restricted). Seeded → intake accepts.
    const r = isPriceableMarket({ state: "IN", city: "Indianapolis", zip: "46218" }, seeded);
    expect(r).toEqual({ actionable: true, reason: null });
  });

  it("an unconfigured disclosure metro that is NOT seeded holds (no per-ZIP comps)", () => {
    const r = isPriceableMarket({ state: "IN", city: "Indianapolis", zip: "46201" }, seeded);
    expect(r.actionable).toBe(false);
    expect(r.reason).toBe("no_seeded_zip");
  });

  it("Detroit ZIP without a seed is NOT priceable", () => {
    const r = isPriceableMarket({ state: "MI", city: "Detroit", zip: "48228" }, seeded);
    expect(r.actionable).toBe(false);
    expect(r.reason).toBe("no_seeded_zip");
  });

  it("San Antonio TX (non-disclosure, opener holds) is NOT priceable — even though it's actionable", () => {
    expect(isActionableMarket({ state: "TX", city: "San Antonio", zip: "78201" }).actionable).toBe(true);
    const r = isPriceableMarket({ state: "TX", city: "San Antonio", zip: "78201" }, seeded);
    expect(r.actionable).toBe(false);
    expect(r.reason).toBe("opener_holds_market");
  });

  it("NON-DISCLOSURE holds even when SEEDED — a seed alone never unlocks TX (78201 is in `seeded`)", () => {
    // Guards the doctrine: the opener HOLDs non-disclosure regardless of comps,
    // so intake must too. The opener-lane gate (a) fires before the seed gate (b).
    const r = isPriceableMarket({ state: "TX", city: "San Antonio", zip: "78201" }, seeded);
    expect(r.reason).toBe("opener_holds_market");
  });

  it("Dallas TX (configured but arv_source_verified=false → dormant) holds at the opener gate", () => {
    // Old gate let Dallas pass on its raw arv_pct_max (0.5883) and only failed on
    // the seed; the opener-aligned gate holds it correctly as configured-unverified.
    const r = isPriceableMarket({ state: "TX", city: "Dallas", zip: "75201" }, seeded);
    expect(r.actionable).toBe(false);
    expect(r.reason).toBe("opener_holds_market");
  });

  it("a restricted state stays excluded under the priceable gate too", () => {
    expect(isPriceableMarket({ state: "IL", zip: "60601" }, seeded).reason).toBe("wholesale_restricted_state");
  });
});

// ── Seeded non-disclosure ZIPs must be crawlable (2026-08-13) ─────────────
// The San Antonio dead-end: the opener ruling let a seeded TX ZIP price, but
// THIS gate decides what intake will even scrape, and it still answered the
// state-level question — so no SA listing could enter the table to be priced.
describe("isPriceableMarket — self-pricing ZIPs in a non-disclosure state", () => {
  const SA = { state: "TX", city: "San Antonio", zip: "78207" };
  const seeded = new Set(["78207"]);

  it("still holds a non-disclosure ZIP when no self-pricing set is supplied", () => {
    expect(isPriceableMarket(SA, seeded).actionable).toBe(false);
    expect(isPriceableMarket(SA, seeded).reason).toBe("opener_holds_market");
  });

  it("still holds when the ZIP is seeded but NOT self-pricing", () => {
    const v = isPriceableMarket(SA, seeded, new Set(["78999"]));
    expect(v.actionable).toBe(false);
    expect(v.reason).toBe("opener_holds_market");
  });

  it("becomes priceable when the ZIP carries a self-pricing seed", () => {
    const v = isPriceableMarket(SA, seeded, seeded);
    expect(v.actionable).toBe(true);
    expect(v.reason).toBeNull();
  });

  it("a self-pricing seed does NOT rescue an excluded state", () => {
    const il = { state: "IL", city: "Chicago", zip: "60620" };
    const v = isPriceableMarket(il, new Set(["60620"]), new Set(["60620"]));
    expect(v.actionable).toBe(false);
    expect(v.reason).not.toBe("opener_holds_market"); // excluded earlier, by geography
  });

  it("a self-pricing seed does NOT bypass the seeded-ZIP requirement", () => {
    const v = isPriceableMarket(SA, new Set<string>(), seeded);
    expect(v.actionable).toBe(false);
    expect(v.reason).toBe("no_seeded_zip");
  });
});

// ── Freshness lane / send lane coverage parity (2026-09-16) ────────────────
// The 114-record verify_stale floor (crier/h2_supply_floor_below, 2026-09-14):
// in list-anchor mode the send lane's ZIP coverage unions the registry's
// launch/active ZIPs into first-touch coverage (app/api/cron/h2-outreach
// resolveCoverage + lib/zip-registry getActiveIntakeZips), but the freshness
// route gated re-verification on isPriceableMarket's seeded-ZIP + buy-box
// test regardless of mode — a registry-covered, non-seeded ZIP could never
// be re-verified Active, so it could never reach the Sendable queue.
describe("isFreshnessPriceableMarket — list-anchor coverage parity", () => {
  const seeded = new Set(["48227"]); // does NOT include the registry-only zip below
  const registryZips = new Set(["44128"]); // Cleveland — registry-covered, unseeded

  it("a registry ZIP with no seed is a freshness candidate in list-anchor mode", () => {
    const v = isFreshnessPriceableMarket(
      { state: "OH", city: "Cleveland", zip: "44128" },
      seeded,
      undefined,
      { listAnchorModeActive: true, registryZips },
    );
    expect(v).toEqual({ actionable: true, reason: null });
  });

  it("the SAME record is NOT a candidate when list-anchor mode is off", () => {
    const v = isFreshnessPriceableMarket(
      { state: "OH", city: "Cleveland", zip: "44128" },
      seeded,
      undefined,
      { listAnchorModeActive: false, registryZips },
    );
    expect(v.actionable).toBe(false);
    // Falls back to the unmodified isPriceableMarket verdict.
    expect(v).toEqual(isPriceableMarket({ state: "OH", city: "Cleveland", zip: "44128" }, seeded, undefined));
  });

  it("a ZIP that is neither seeded nor registry-covered stays a HOLD even in list-anchor mode", () => {
    const v = isFreshnessPriceableMarket(
      { state: "OH", city: "Columbus", zip: "43215" },
      seeded,
      undefined,
      { listAnchorModeActive: true, registryZips },
    );
    expect(v.actionable).toBe(false);
    expect(v.reason).toBe("no_seeded_zip");
  });

  it("list-anchor mode never rescues a hard-excluded state via registry coverage", () => {
    const v = isFreshnessPriceableMarket(
      { state: "IL", city: "Chicago", zip: "60620" },
      seeded,
      undefined,
      { listAnchorModeActive: true, registryZips: new Set(["60620"]) },
    );
    expect(v.actionable).toBe(false);
    expect(v.reason).toBe("wholesale_restricted_state");
  });

  it("an already-priceable (seeded) ZIP is unaffected by list-anchor mode", () => {
    const v = isFreshnessPriceableMarket(
      { state: "MI", city: "Detroit", zip: "48227" },
      seeded,
      undefined,
      { listAnchorModeActive: true, registryZips: new Set<string>() },
    );
    expect(v).toEqual({ actionable: true, reason: null });
  });
});
