// @agent: appraiser — MAO range math tests.

import { describe, it, expect } from "vitest";
import {
  classifyArvConfidenceByCount,
  requiresManualReview,
  computeMaoRange,
  pickCalibratedRehab,
} from "./mao-range";

describe("classifyArvConfidenceByCount", () => {
  it("returns HIGH for 5+ comps", () => {
    expect(classifyArvConfidenceByCount(5)).toBe("HIGH");
    expect(classifyArvConfidenceByCount(7)).toBe("HIGH");
    expect(classifyArvConfidenceByCount(99)).toBe("HIGH");
  });

  it("returns MED for 3-4 comps", () => {
    expect(classifyArvConfidenceByCount(3)).toBe("MED");
    expect(classifyArvConfidenceByCount(4)).toBe("MED");
  });

  it("returns LOW for <3 comps", () => {
    expect(classifyArvConfidenceByCount(0)).toBe("LOW");
    expect(classifyArvConfidenceByCount(1)).toBe("LOW");
    expect(classifyArvConfidenceByCount(2)).toBe("LOW");
  });

  it("returns LOW for null/undefined/negative/non-finite (defensive)", () => {
    expect(classifyArvConfidenceByCount(null)).toBe("LOW");
    expect(classifyArvConfidenceByCount(undefined)).toBe("LOW");
    expect(classifyArvConfidenceByCount(-3)).toBe("LOW");
    expect(classifyArvConfidenceByCount(NaN)).toBe("LOW");
    expect(classifyArvConfidenceByCount(Infinity)).toBe("LOW"); // non-finite guard
  });
});

describe("requiresManualReview", () => {
  it("is true only for LOW", () => {
    expect(requiresManualReview("LOW")).toBe(true);
    expect(requiresManualReview("MED")).toBe(false);
    expect(requiresManualReview("HIGH")).toBe(false);
  });
});

describe("pickCalibratedRehab (Phase 4B.1 / J.3)", () => {
  it("prefers Phase 4B.1 calibrated estRehabMid over legacy estRehab", () => {
    const r = pickCalibratedRehab({ estRehabMid: 45_000, estRehab: 60_000 });
    expect(r.value).toBe(45_000);
    expect(r.source).toBe("phase_4b_calibrated");
  });

  it("falls back to legacy estRehab when estRehabMid is null", () => {
    const r = pickCalibratedRehab({ estRehabMid: null, estRehab: 60_000 });
    expect(r.value).toBe(60_000);
    expect(r.source).toBe("legacy_est_rehab");
  });

  it("falls back to legacy estRehab when estRehabMid is undefined", () => {
    const r = pickCalibratedRehab({ estRehab: 60_000 });
    expect(r.value).toBe(60_000);
    expect(r.source).toBe("legacy_est_rehab");
  });

  it("falls back to legacy estRehab when estRehabMid is zero", () => {
    // Zero is treated as 'not really populated' — same as null
    const r = pickCalibratedRehab({ estRehabMid: 0, estRehab: 60_000 });
    expect(r.value).toBe(60_000);
    expect(r.source).toBe("legacy_est_rehab");
  });

  it("returns none when both fields are missing", () => {
    const r = pickCalibratedRehab({});
    expect(r.value).toBeNull();
    expect(r.source).toBe("none");
  });

  it("returns none when both fields are null/zero", () => {
    const r = pickCalibratedRehab({ estRehabMid: null, estRehab: 0 });
    expect(r.value).toBeNull();
    expect(r.source).toBe("none");
  });

  it("uses calibrated when only estRehabMid is populated (no legacy)", () => {
    const r = pickCalibratedRehab({ estRehabMid: 45_000 });
    expect(r.value).toBe(45_000);
    expect(r.source).toBe("phase_4b_calibrated");
  });
});

describe("computeMaoRange — V2.1 floor math", () => {
  it("computes floor as arv − rehab − wholesale_fee", () => {
    const r = computeMaoRange({
      arvMid: 165_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      listPrice: 130_000,
      sellerMotivationScore: null,
    });
    expect(r.floor).toBe(90_000);
  });

  it("validation anchor: 1219 E Highland Blvd 78210 → ~$90K MAO", () => {
    // San Antonio (78210) is data_state_default=renovated per the
    // arv-intelligence engine, so arv_mid IS the renovated retail
    // value. Subject sqft × avg comp $/sqft → ARV. With representative
    // SA wholesale numbers (Est_Rehab ~60K, Wholesale_Fee_Target 15K
    // default), the floor lands at ~$90K. This test is the canonical
    // Phase 4A.1 validation fixture per the sprint brief.
    const r = computeMaoRange({
      arvMid: 165_000,
      estRehab: 60_000,
      wholesaleFee: null, // uses default 15000
      listPrice: 140_000,
      sellerMotivationScore: null,
    });
    expect(r.floor).toBe(90_000);
    expect(r.target).toBe(90_000); // motivation null → target = floor
  });

  it("clamps floor to 0 when subtraction would go negative", () => {
    const r = computeMaoRange({
      arvMid: 50_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      listPrice: 80_000,
      sellerMotivationScore: null,
    });
    expect(r.floor).toBe(0);
  });

  it("defaults wholesale_fee to 15000 when null", () => {
    const r = computeMaoRange({
      arvMid: 200_000,
      estRehab: 30_000,
      wholesaleFee: null,
      listPrice: 175_000,
      sellerMotivationScore: null,
    });
    expect(r.floor).toBe(200_000 - 30_000 - 15_000);
    expect(r.modifier_inputs.wholesale_fee).toBe(15_000);
  });

  it("defaults buyer_profit to 30000 when null (surfaced in modifier_inputs only)", () => {
    const r = computeMaoRange({
      arvMid: 200_000,
      estRehab: 30_000,
      wholesaleFee: 15_000,
      buyerProfit: null,
      listPrice: 175_000,
      sellerMotivationScore: null,
    });
    expect(r.modifier_inputs.buyer_profit).toBe(30_000);
    // Floor formula does NOT subtract buyer_profit by design.
    expect(r.floor).toBe(155_000);
  });

  it("returns null floor + null target when arvMid is missing", () => {
    const r = computeMaoRange({
      arvMid: null,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      listPrice: 130_000,
      sellerMotivationScore: null,
    });
    expect(r.floor).toBeNull();
    expect(r.target).toBeNull();
    // modifier_inputs still surfaced so caller can recompute later
    expect(r.modifier_inputs.est_rehab).toBe(60_000);
    expect(r.modifier_inputs.list_price).toBe(130_000);
  });

  it("returns null floor + null target when estRehab is missing", () => {
    const r = computeMaoRange({
      arvMid: 165_000,
      estRehab: null,
      wholesaleFee: 15_000,
      listPrice: 130_000,
      sellerMotivationScore: null,
    });
    expect(r.floor).toBeNull();
    expect(r.target).toBeNull();
  });
});

describe("computeMaoRange — soft ceiling (75% of List)", () => {
  it("computes soft_ceiling as 75% of list_price rounded", () => {
    const r = computeMaoRange({
      arvMid: 200_000,
      estRehab: 0,
      wholesaleFee: 0,
      listPrice: 100_000,
      sellerMotivationScore: null,
    });
    expect(r.soft_ceiling).toBe(75_000);
  });

  it("flags exceeds_soft_ceiling when target > 75% of list_price", () => {
    // ARV 200K, Rehab 0, Wholesale 0, List 100K → floor 200K → target 200K
    // → exceeds 75K soft ceiling
    const r = computeMaoRange({
      arvMid: 200_000,
      estRehab: 0,
      wholesaleFee: 0,
      listPrice: 100_000,
      sellerMotivationScore: null,
    });
    expect(r.exceeds_soft_ceiling).toBe(true);
  });

  it("does NOT flag exceeds_soft_ceiling when target ≤ 75% of list_price", () => {
    const r = computeMaoRange({
      arvMid: 165_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      listPrice: 140_000,
      sellerMotivationScore: null,
    });
    // floor 90K, 75% of 140K = 105K → 90K < 105K, no flag
    expect(r.exceeds_soft_ceiling).toBe(false);
  });

  it("returns null soft_ceiling when list_price is missing", () => {
    const r = computeMaoRange({
      arvMid: 165_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      listPrice: null,
      sellerMotivationScore: null,
    });
    expect(r.soft_ceiling).toBeNull();
    expect(r.exceeds_soft_ceiling).toBe(false);
  });
});

describe("computeMaoRange — modifier_inputs preservation", () => {
  it("surfaces seller_motivation_score even when null (Phase 13 reads this)", () => {
    const r = computeMaoRange({
      arvMid: 165_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      listPrice: 140_000,
      sellerMotivationScore: 4,
    });
    expect(r.modifier_inputs.seller_motivation_score).toBe(4);
  });

  it("target equals floor in Phase 4A.1 regardless of motivation score (modifier deferred to Phase 13)", () => {
    const r5 = computeMaoRange({
      arvMid: 165_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      listPrice: 140_000,
      sellerMotivationScore: 5,
    });
    const r1 = computeMaoRange({
      arvMid: 165_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      listPrice: 140_000,
      sellerMotivationScore: 1,
    });
    expect(r5.target).toBe(r5.floor);
    expect(r1.target).toBe(r1.floor);
    expect(r5.target).toBe(r1.target);
  });
});
