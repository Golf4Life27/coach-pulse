import { describe, it, expect } from "vitest";
import { computeRoughOpenerCeiling, ROUGH_REHAB_PCT_OF_ARV } from "./rough-opener-ceiling";

const DETROIT = 0.6461;

describe("computeRoughOpenerCeiling — value-anchored buy-box path (ARV + vision rehab)", () => {
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

describe("computeRoughOpenerCeiling — HOLD, never list-anchor (the catastrophe fix, 2026-06-28)", () => {
  it("no ARV → HOLD (ceiling null), NEVER a fraction of list — the 18681 Blackmoor $84.5k bug", () => {
    // The live failure: 0.65 × $130k list = $84.5k texted on a house worth
    // ~$40k. With the list-anchor retired, no ARV value basis → HOLD.
    const r = computeRoughOpenerCeiling({ listPrice: 130_000, arvPctMax: DETROIT });
    expect(r.ceiling).toBeNull();
    expect(r.source).toBe("hold_no_value_basis");
  });
  it("ARV present but NO sourced buy-box (arvPctMax null) → HOLD (cannot value-anchor)", () => {
    const r = computeRoughOpenerCeiling({ realArvMedian: 120_000, listPrice: 100_000, arvPctMax: null });
    expect(r.ceiling).toBeNull();
    expect(r.source).toBe("hold_no_value_basis");
  });
  it("list price feeds NOTHING in the ceiling math — same HOLD with or without it", () => {
    const withList = computeRoughOpenerCeiling({ listPrice: 200_000, arvPctMax: DETROIT });
    const without = computeRoughOpenerCeiling({ arvPctMax: DETROIT });
    expect(withList.ceiling).toBeNull();
    expect(without.ceiling).toBeNull();
    expect(withList.source).toBe(without.source);
  });
  it("ARV + buy-box still wins — a real value basis prices the house", () => {
    const r = computeRoughOpenerCeiling({ realArvMedian: 100_000, listPrice: 130_000, arvPctMax: DETROIT });
    expect(r.source).toBe("rough_buybox_arv_placeholder_rehab"); // value path, not a hold
    expect(r.ceiling).toBe(39_610);
  });
  it("no inputs at all → HOLD", () => {
    const r = computeRoughOpenerCeiling({});
    expect(r.ceiling).toBeNull();
    expect(r.source).toBe("hold_no_value_basis");
  });
});

describe("constants", () => {
  it("rehab placeholder fraction is 0.20", () => {
    expect(ROUGH_REHAB_PCT_OF_ARV).toBe(0.20);
  });
});
