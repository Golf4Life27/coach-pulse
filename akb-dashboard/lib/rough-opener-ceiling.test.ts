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
