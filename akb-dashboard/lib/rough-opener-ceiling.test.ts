import { describe, it, expect } from "vitest";
import { computeRoughOpenerCeiling, ROUGH_REHAB_PCT_OF_ARV, ROUGH_NOARV_CEILING_PCT } from "./rough-opener-ceiling";

const DETROIT = 0.6461;

describe("computeRoughOpenerCeiling — buy-box path (ARV + vision rehab)", () => {
  it("Rosemary: ARV 89,816 × 0.6461 − rehab 25,769 − fee 5,000 = 27,261", () => {
    const r = computeRoughOpenerCeiling({ realArvMedian: 89_816, estRehabMid: 25_769, arvPctMax: DETROIT });
    expect(r.source).toBe("rough_buybox_arv");
    expect(r.ceiling).toBe(27_261);
  });
  it("Frisbee: ARV 164,823 (above list) → ceiling 76,298", () => {
    const r = computeRoughOpenerCeiling({ realArvMedian: 164_823, estRehabMid: 25_194, arvPctMax: DETROIT });
    expect(r.ceiling).toBe(76_298);
  });
  it("placeholder rehab when ARV present but no vision rehab", () => {
    const r = computeRoughOpenerCeiling({ realArvMedian: 100_000, arvPctMax: DETROIT });
    expect(r.source).toBe("rough_buybox_arv_placeholder_rehab");
    // rehab = 100000 × 0.20 = 20000; ceiling = 64610 − 20000 − 5000 = 39610
    expect(r.rehabUsed).toBe(20_000);
    expect(r.ceiling).toBe(39_610);
  });
  it("clamps to 0, never negative (deep rehab > buy-box ARV)", () => {
    const r = computeRoughOpenerCeiling({ realArvMedian: 50_000, estRehabMid: 60_000, arvPctMax: DETROIT });
    expect(r.ceiling).toBe(0);
  });
  it("honors Wholesale_Fee_Target override", () => {
    const a = computeRoughOpenerCeiling({ realArvMedian: 100_000, estRehabMid: 10_000, arvPctMax: DETROIT, wholesaleFee: 15_000 });
    const b = computeRoughOpenerCeiling({ realArvMedian: 100_000, estRehabMid: 10_000, arvPctMax: DETROIT });
    expect(b.ceiling! - a.ceiling!).toBe(10_000); // $5k vs $15k fee
  });
});

describe("computeRoughOpenerCeiling — no-ARV fallback", () => {
  it("falls back to list × 0.72 when no ARV", () => {
    const r = computeRoughOpenerCeiling({ listPrice: 100_000, arvPctMax: DETROIT });
    expect(r.source).toBe("list_fraction_no_arv");
    expect(r.ceiling).toBe(72_000);
  });
  it("no ARV because market not priceable (no arvPctMax) → still list fallback", () => {
    const r = computeRoughOpenerCeiling({ realArvMedian: 90_000, listPrice: 100_000, arvPctMax: null });
    expect(r.source).toBe("list_fraction_no_arv");
  });
  it("0.90 anchor × list-fraction ceiling ≈ legacy 0.65-of-list opener", () => {
    const r = computeRoughOpenerCeiling({ listPrice: 100_000, arvPctMax: null });
    const opener = Math.round(0.90 * r.ceiling!);
    expect(opener).toBe(64_800); // ≈ 65% of list, the legacy door-opener
  });
});

describe("computeRoughOpenerCeiling — no-ARV → buyer-median anchor (the catastrophe fix)", () => {
  it("BLACKMOOR: no ARV, 48234 buyer-median $35k → $30k opener, NOT the $84k list-anchored bug", () => {
    // The live failure: 18681 Blackmoor texted ≈0.65 × $130k list = ~$84.5k.
    // With the ZIP buyer-median ($35k) as the anchor it caps at $30k.
    const r = computeRoughOpenerCeiling({ listPrice: 130_000, buyerMedian: 35_000, arvPctMax: DETROIT });
    expect(r.source).toBe("buyer_median_no_arv");
    expect(r.ceiling).toBe(30_000); // 35k − 5k fee
    // …and structurally far below what the old list-fraction would have produced.
    expect(r.ceiling!).toBeLessThan(Math.round(130_000 * ROUGH_NOARV_CEILING_PCT)); // 93,600
  });
  it("buyer-median takes precedence over list — never anchors to list when a median exists", () => {
    const r = computeRoughOpenerCeiling({ listPrice: 200_000, buyerMedian: 50_000 });
    expect(r.source).toBe("buyer_median_no_arv");
    expect(r.ceiling).toBe(45_000); // 50k − 5k fee, NOT 200k × 0.72
  });
  it("ARV still wins over buyer-median (best value data first)", () => {
    const r = computeRoughOpenerCeiling({ realArvMedian: 100_000, buyerMedian: 35_000, arvPctMax: DETROIT });
    expect(r.source).toBe("rough_buybox_arv_placeholder_rehab"); // ARV path, not the median
  });
  it("falls through to list-fraction ONLY when there is no buyer-median", () => {
    const r = computeRoughOpenerCeiling({ listPrice: 100_000, buyerMedian: null });
    expect(r.source).toBe("list_fraction_no_arv");
  });
  it("honors the fee in the median anchor and clamps to 0", () => {
    expect(computeRoughOpenerCeiling({ buyerMedian: 50_000, wholesaleFee: 15_000 }).ceiling).toBe(35_000);
    expect(computeRoughOpenerCeiling({ buyerMedian: 3_000, wholesaleFee: 5_000 }).ceiling).toBe(0);
  });
});

describe("computeRoughOpenerCeiling — HOLD only when truly nothing", () => {
  it("no ARV and no list → null ceiling, hold", () => {
    const r = computeRoughOpenerCeiling({ arvPctMax: DETROIT });
    expect(r.ceiling).toBeNull();
    expect(r.source).toBe("hold_no_inputs");
  });
});

describe("constants", () => {
  it("defaults: rehab placeholder 0.20, no-arv ceiling 0.72", () => {
    expect(ROUGH_REHAB_PCT_OF_ARV).toBe(0.20);
    expect(ROUGH_NOARV_CEILING_PCT).toBe(0.72);
  });
});
