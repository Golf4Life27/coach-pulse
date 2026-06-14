import { describe, it, expect } from "vitest";
import { priceOpener, FALLBACK_OPENER_PCT_OF_LIST } from "./per-market-pricer";

const DETROIT_BUYBOX = 0.6461;

describe("priceOpener — buy-box ARV path", () => {
  it("anchor × (ARV×buybox − rehab − fee) when ARV + buy-box present", () => {
    // ceiling = 200000×0.6461 − 30000 − 5000 = 94220; opener = 0.90×94220 = 84798
    const r = priceOpener({
      realArvMedian: 200_000,
      estRehabMid: 30_000,
      wholesaleFee: 5_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
      arvConfidence: "STRONG",
    });
    expect(r.basis).toBe("arv_buybox");
    expect(r.confidence).toBe("STRONG");
    expect(r.ceiling).toBe(94_220);
    expect(r.opener).toBe(84_798);
    expect(r.anchorPct).toBe(0.90);
  });

  it("labels STORED when no confidence supplied (pre-computed Real_ARV)", () => {
    const r = priceOpener({
      realArvMedian: 200_000,
      estRehabMid: 30_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
    });
    expect(r.basis).toBe("arv_buybox");
    expect(r.confidence).toBe("STORED");
  });

  it("buy-box that does NOT pencil (rehab eats it) falls back to flat 65% of list — never holds with a list", () => {
    // ceiling = 50000×0.6461 − 40000 − 5000 = negative → 0 → non-penciling
    const r = priceOpener({
      realArvMedian: 50_000,
      estRehabMid: 40_000,
      wholesaleFee: 5_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
      listPrice: 80_000,
    });
    expect(r.basis).toBe("list_fraction_65");
    expect(r.confidence).toBe("FALLBACK");
    expect(r.opener).toBe(52_000); // 0.65 × 80000
  });
});

describe("priceOpener — flat 65%-of-list fallback (ruling #3)", () => {
  it("no ARV → SENT opener is exactly 65% of list", () => {
    const r = priceOpener({ listPrice: 100_000 });
    expect(r.basis).toBe("list_fraction_65");
    expect(r.opener).toBe(65_000);
    expect(r.confidence).toBe("FALLBACK");
  });

  it("is ANCHOR-INDEPENDENT — a calibrated-down anchor does not drag the fallback below 65%", () => {
    const at90 = priceOpener({ listPrice: 120_000, anchorPct: 0.90 });
    const at80 = priceOpener({ listPrice: 120_000, anchorPct: 0.80 });
    expect(at90.opener).toBe(78_000); // 0.65 × 120000
    expect(at80.opener).toBe(78_000); // unchanged — anchor not applied on fallback
    expect(at80.anchorPct).toBeNull();
  });

  it("fallback fires when arv_pct_max is absent even if an ARV exists (no sourced buy-box → no buy-box path)", () => {
    const r = priceOpener({ realArvMedian: 200_000, listPrice: 100_000, arvPctMax: null });
    expect(r.basis).toBe("list_fraction_65");
    expect(r.opener).toBe(65_000);
  });

  it("uses the tunable constant", () => {
    expect(FALLBACK_OPENER_PCT_OF_LIST).toBe(0.65);
  });
});

describe("priceOpener — genuine hold", () => {
  it("no ARV and no list → opener null, basis hold_no_inputs", () => {
    const r = priceOpener({});
    expect(r.opener).toBeNull();
    expect(r.basis).toBe("hold_no_inputs");
    expect(r.confidence).toBe("NONE");
  });
});
