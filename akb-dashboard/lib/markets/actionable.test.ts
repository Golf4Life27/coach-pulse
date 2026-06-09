import { describe, it, expect } from "vitest";
import { isActionableMarket, isPriceableMarket } from "./actionable";

describe("isActionableMarket", () => {
  it("San Antonio TX is actionable (price via ARV, can assign)", () => {
    expect(isActionableMarket({ state: "TX", city: "San Antonio", zip: "78201" })).toEqual({ actionable: true, reason: null });
  });

  it("Detroit MI is actionable", () => {
    expect(isActionableMarket({ state: "MI", city: "Detroit", zip: "48201" }).actionable).toBe(true);
  });

  it("PAUSES Memphis by city (non-assignable clause)", () => {
    const r = isActionableMarket({ state: "TN", city: "Memphis", zip: "38109" });
    expect(r.actionable).toBe(false);
    expect(r.reason).toContain("paused_memphis");
  });

  it("PAUSES Memphis by zip even if city is blank", () => {
    expect(isActionableMarket({ state: "TN", city: null, zip: "38114" }).actionable).toBe(false);
  });

  it("a non-Memphis TN market is still actionable (pause is Memphis-scoped)", () => {
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

describe("isPriceableMarket — sourced arv_pct_max AND seeded buyer-median", () => {
  const seeded = new Set(["48227"]);

  it("Detroit 48227 (sourced 0.6461 + seeded) is PRICEABLE", () => {
    expect(isPriceableMarket({ state: "MI", city: "Detroit", zip: "48227" }, seeded)).toEqual({ actionable: true, reason: null });
  });

  it("Detroit ZIP without a seeded median is NOT priceable", () => {
    const r = isPriceableMarket({ state: "MI", city: "Detroit", zip: "48228" }, seeded);
    expect(r.actionable).toBe(false);
    expect(r.reason).toBe("no_seeded_buyer_median");
  });

  it("San Antonio TX (no sourced arv_pct_max) is NOT priceable — even though it's actionable", () => {
    expect(isActionableMarket({ state: "TX", city: "San Antonio", zip: "78201" }).actionable).toBe(true);
    const r = isPriceableMarket({ state: "TX", city: "San Antonio", zip: "78201" }, seeded);
    expect(r.actionable).toBe(false);
    expect(r.reason).toBe("no_sourced_arv_pct_max");
  });

  it("Dallas TX (has arv_pct_max 0.5883 but NO seeded median) is NOT priceable", () => {
    // Even with a sourced buy-box %, no seeded ZIP median → can't price.
    const r = isPriceableMarket({ state: "TX", city: "Dallas", zip: "75201" }, seeded);
    expect(r.actionable).toBe(false);
    expect(r.reason).toBe("no_seeded_buyer_median");
  });

  it("a restricted state stays excluded under the priceable gate too", () => {
    expect(isPriceableMarket({ state: "IL", zip: "60601" }, seeded).reason).toBe("wholesale_restricted_state");
  });
});
