import { describe, it, expect } from "vitest";
import { isActionableMarket } from "./actionable";

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
