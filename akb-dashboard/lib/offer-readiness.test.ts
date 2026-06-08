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
    const r = computeOfferReadiness({ ...FULL, hasOperatorCma: false, buyerCeiling: null });
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(["CMA", "Buyer ceiling (InvestorBase)"]));
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
