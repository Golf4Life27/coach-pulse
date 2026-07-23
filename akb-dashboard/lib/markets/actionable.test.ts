import { describe, it, expect } from "vitest";
import { isActionableMarket, isPriceableMarket } from "./actionable";

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
