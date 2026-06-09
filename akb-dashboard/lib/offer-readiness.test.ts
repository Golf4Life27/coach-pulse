// @agent: orchestrator — offer-readiness checklist (the four-data gate).
import { describe, it, expect } from "vitest";
import { computeOfferReadiness } from "./offer-readiness";

const FULL = {
  realArvMedian: 132_000,
  arvConfidence: "MED" as const,
  arvCompCount: 7,
  estRehabMid: 37_000,
  rehabConfidenceScore: 62,
  hasOperatorCma: true,
  buyerCeiling: 95_000,
};

describe("computeOfferReadiness", () => {
  it("all four present → ready, nothing missing", () => {
    const r = computeOfferReadiness(FULL);
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.items.every((i) => i.ok)).toBe(true);
  });

  it("missing rehab → not ready, rehab flagged", () => {
    const r = computeOfferReadiness({ ...FULL, estRehabMid: null, estRehab: null });
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("Rehab estimate");
  });

  it("falls back to estRehab when estRehabMid absent", () => {
    const r = computeOfferReadiness({ ...FULL, estRehabMid: null, estRehab: 28_000 });
    expect(r.items.find((i) => i.key === "rehab")?.ok).toBe(true);
  });

  it("no CMA and no buyer ceiling → both flagged (the common Detroit case)", () => {
    // Detroit is MI — a disclosure state, so the ceiling source is InvestorBase.
    const r = computeOfferReadiness({ ...FULL, state: "MI", hasOperatorCma: false, buyerCeiling: null, investorBaseMedian: null });
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(["CMA", "Buyer ceiling (InvestorBase)"]));
  });

  it("disclosure state (MI) with no explicit ceiling resolves off InvestorBase median", () => {
    const r = computeOfferReadiness({ ...FULL, state: "MI", buyerCeiling: null, investorBaseMedian: 118_000 });
    const bc = r.items.find((i) => i.key === "buyer_ceiling");
    expect(bc?.ok).toBe(true);
    expect(bc?.label).toBe("Buyer ceiling (InvestorBase)");
    expect(bc?.detail).toContain("$118,000");
    expect(bc?.detail).toContain("InvestorBase");
  });

  it("non-disclosure state (TX) discounts ARV by the SOURCED buy-box, ignores InvestorBase", () => {
    // Dallas (TX 75201) has a sourced buy-box (arv_pct_max 0.5883). The
    // ceiling is ARV × 0.5883 — a buyer PURCHASE price, never the raw resale
    // ARV — and InvestorBase is ignored in a non-disclosure state.
    const r = computeOfferReadiness({ ...FULL, state: "TX", zip: "75201", buyerCeiling: null, realArvMedian: 265_846, investorBaseMedian: 9_999 });
    const bc = r.items.find((i) => i.key === "buyer_ceiling");
    expect(bc?.ok).toBe(true);
    expect(bc?.label).toBe("Buyer ceiling (ARV buy-box)");
    // 265,846 × 0.5883 = 156,397 — NOT the raw $265,846 resale value.
    expect(bc?.detail).toContain("$156,397");
    expect(bc?.detail).toContain("buy-box");
    expect(bc?.detail).not.toContain("265,846");
    expect(bc?.detail).not.toContain("9,999");
  });

  it("San Antonio (TX 78210, no sourced buy-box) HOLDs — never prices resale ARV as a purchase ceiling", () => {
    // The 1219 E Highland anchor case: SA has buyer_params:null, so there is
    // NO sourced discount. The ceiling must HOLD rather than return raw ARV.
    const r = computeOfferReadiness({ ...FULL, state: "TX", zip: "78210", buyerCeiling: null, realArvMedian: 265_846, investorBaseMedian: 9_999 });
    const bc = r.items.find((i) => i.key === "buyer_ceiling");
    expect(bc?.ok).toBe(false);
    expect(r.missing).toContain("Buyer ceiling (ARV buy-box)");
  });

  it("non-disclosure state (TX) with no ARV → buyer ceiling HOLDs (never fabricated)", () => {
    const r = computeOfferReadiness({ ...FULL, state: "TX", zip: "75201", buyerCeiling: null, realArvMedian: null, investorBaseMedian: 120_000 });
    const bc = r.items.find((i) => i.key === "buyer_ceiling");
    expect(bc?.ok).toBe(false);
    expect(r.missing).toContain("Buyer ceiling (ARV buy-box)");
  });

  it("zero / negative values do not count as present", () => {
    const r = computeOfferReadiness({ realArvMedian: 0, estRehabMid: -1, hasOperatorCma: false, buyerCeiling: 0 });
    expect(r.ready).toBe(false);
    expect(r.missing.length).toBe(4);
  });

  it("ARV detail surfaces value + confidence + comp count", () => {
    const r = computeOfferReadiness(FULL);
    const arv = r.items.find((i) => i.key === "arv");
    expect(arv?.detail).toContain("$132,000");
    expect(arv?.detail).toContain("MED");
    expect(arv?.detail).toContain("7 comps");
  });
});
