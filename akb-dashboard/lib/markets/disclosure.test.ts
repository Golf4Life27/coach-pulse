import { describe, it, expect } from "vitest";
import {
  isDisclosureState,
  pricingPathForState,
  resolveBuyerCeiling,
} from "./disclosure";

describe("isDisclosureState / pricingPathForState", () => {
  it("TX is non-disclosure → arv_comps path", () => {
    expect(isDisclosureState("TX")).toBe(false);
    expect(pricingPathForState("TX")).toBe("arv_comps");
  });
  it("MI / TN are disclosure → investorbase path", () => {
    expect(isDisclosureState("MI")).toBe(true);
    expect(isDisclosureState("TN")).toBe(true);
    expect(pricingPathForState("MI")).toBe("investorbase_median");
  });
  it("unknown/blank state → treated as non-disclosure (safer)", () => {
    expect(isDisclosureState(null)).toBe(false);
    expect(isDisclosureState("")).toBe(false);
  });
});

describe("resolveBuyerCeiling", () => {
  it("disclosure: uses InvestorBase median directly (a real purchase price)", () => {
    const r = resolveBuyerCeiling("MI", { investorBaseMedian: 118_000, arvMedian: 200_000 });
    expect(r).toEqual({ ceiling: 118_000, source: "investorbase_median", reason: null });
  });

  it("disclosure: missing InvestorBase median → HOLD", () => {
    const r = resolveBuyerCeiling("MI", { investorBaseMedian: null, arvMedian: 200_000 });
    expect(r.ceiling).toBeNull();
    expect(r.reason).toBe("disclosure_state_missing_investorbase_median");
  });

  it("non-disclosure: discounts ARV by the sourced buy-box, NEVER raw resale ARV", () => {
    const r = resolveBuyerCeiling("TX", { arvMedian: 265_846, arvDiscountPct: 0.5883, investorBaseMedian: 9_999 });
    expect(r.source).toBe("arv_comps");
    expect(r.ceiling).toBe(156_397); // 265,846 × 0.5883, rounded
    expect(r.ceiling).not.toBe(265_846); // not the raw resale value
  });

  it("non-disclosure: missing sourced discount (e.g. San Antonio) → HOLD, never raw ARV", () => {
    const r = resolveBuyerCeiling("TX", { arvMedian: 265_846, arvDiscountPct: null });
    expect(r.ceiling).toBeNull();
    expect(r.reason).toBe("non_disclosure_state_missing_sourced_buybox_discount");
  });

  it("non-disclosure: missing ARV → HOLD", () => {
    const r = resolveBuyerCeiling("TX", { arvMedian: null, arvDiscountPct: 0.5883 });
    expect(r.ceiling).toBeNull();
    expect(r.reason).toBe("non_disclosure_state_missing_arv");
  });

  it("non-disclosure: rejects an out-of-range discount (>1) as unsourced → HOLD", () => {
    const r = resolveBuyerCeiling("TX", { arvMedian: 200_000, arvDiscountPct: 1.4 });
    expect(r.ceiling).toBeNull();
    expect(r.reason).toBe("non_disclosure_state_missing_sourced_buybox_discount");
  });

  it("never crosses streams: a TX property is not priced off InvestorBase even if present", () => {
    const r = resolveBuyerCeiling("TX", { investorBaseMedian: 120_000, arvMedian: null, arvDiscountPct: 0.5883 });
    expect(r.ceiling).toBeNull(); // HOLD on missing ARV, not the InvestorBase number
  });
});
