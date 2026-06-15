import { describe, it, expect } from "vitest";
import { priceOpener, FALLBACK_OPENER_PCT_OF_LIST, NEVER_OVER_LIST_PCT } from "./per-market-pricer";

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

describe("GUARD A — never-over-list cap (Hole A)", () => {
  it("clamps an over-list opener down to the list price and flags re-seed", () => {
    // 14299 Kilbourne: garbage-high ARV → opener would be ~$87,882 on a
    // $47,900 list. Must cap to list, never over asking.
    const r = priceOpener({
      listPrice: 47_900,
      realArvMedian: 230_120,
      estRehabMid: 46_024,
      wholesaleFee: 5_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
    });
    expect(r.cappedToList).toBe(true);
    expect(r.opener).toBe(43_110); // 0.90 × 47,900 — capped with negotiating room
    expect(r.flagReseed).toBe(true);
  });

  it("a STRONG seed that gets capped is NOT flagged for re-seed (guard fired, seed trusted)", () => {
    // Deep-discount listing: STRONG renovated seed → ARV ≫ list → opener > cap.
    // The cap fires (cappedToList) but the seed is good, so flagReseed stays false.
    const r = priceOpener({
      listPrice: 47_900,
      realArvMedian: 230_120,
      estRehabMid: 46_024,
      wholesaleFee: 5_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
      arvConfidence: "STRONG",
    });
    expect(r.cappedToList).toBe(true);
    expect(r.flagReseed).toBe(false); // STRONG → trusted, not a re-seed candidate
    expect(r.opener).toBe(43_110);
  });

  it("a THIN/unlabeled ARV that gets capped IS flagged for re-seed", () => {
    const r = priceOpener({
      listPrice: 47_900,
      realArvMedian: 230_120,
      estRehabMid: 46_024,
      wholesaleFee: 5_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
      arvConfidence: "THIN",
    });
    expect(r.cappedToList).toBe(true);
    expect(r.flagReseed).toBe(true); // THIN → re-pull could fix it
  });

  it("caps at 90% of list (default), leaving negotiating room — never opens at asking", () => {
    expect(NEVER_OVER_LIST_PCT).toBe(0.90);
    // Strong deal: renovated ARV far above a low list → buy-box wants > list.
    const r = priceOpener({
      listPrice: 79_000,
      realArvMedian: 212_860,
      estRehabMid: 37_434,
      wholesaleFee: 5_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
    });
    expect(r.cappedToList).toBe(true);
    expect(r.opener).toBe(71_100); // 0.90 × 79,000, not 79,000
    expect(r.opener).toBeLessThan(79_000);
  });
});

describe("GUARD B — low-opener floor (Hole B)", () => {
  it("routes a sub-floor buy-box micro-opener to the clean 65% rail", () => {
    // 16093 Liberal: ARV $72,518 (> list, so sanity passes) but $39,950
    // rehab squeezes the ceiling → ~$1,714 opener. Floor → 65% of list.
    const r = priceOpener({
      listPrice: 20_000,
      realArvMedian: 72_518,
      estRehabMid: 39_950,
      wholesaleFee: 5_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
    });
    expect(r.flooredToFallback).toBe(true);
    expect(r.basis).toBe("list_fraction_65");
    expect(r.opener).toBe(13_000); // 0.65 × 20000, not the $1,714 micro-number
  });

  it("a healthy buy-box opener above the floor and below list survives unguarded", () => {
    // 16241 E State Fair: ARV $137,456 > list, opener ~$50,687 (57% of list).
    const r = priceOpener({
      listPrice: 88_500,
      realArvMedian: 137_456,
      estRehabMid: 27_491,
      wholesaleFee: 5_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
    });
    expect(r.basis).toBe("arv_buybox");
    expect(r.flooredToFallback).toBe(false);
    expect(r.cappedToList).toBe(false);
    expect(r.arvDistrusted).toBe(false);
    expect(r.opener).toBe(50_687);
  });
});

describe("GUARD C — ARV-sanity gate (Hole C)", () => {
  it("distrusts a below-list ARV, drops to 65% rail, flags re-seed", () => {
    // 15509 Lauder: ARV $93,818 < list $119,000 → as-is/wrong-basis.
    const r = priceOpener({
      listPrice: 119_000,
      realArvMedian: 93_818,
      estRehabMid: 34_425,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
    });
    expect(r.arvDistrusted).toBe(true);
    expect(r.flagReseed).toBe(true);
    expect(r.basis).toBe("list_fraction_65");
    expect(r.opener).toBe(77_350); // 0.65 × 119000
  });

  it("a STRONG seed below list is distrusted for pricing but NOT flagged for re-seed (over-ARV listing, good seed)", () => {
    const r = priceOpener({
      listPrice: 119_000,
      realArvMedian: 93_818,
      estRehabMid: 34_425,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
      arvConfidence: "STRONG",
    });
    expect(r.arvDistrusted).toBe(true);   // still drops to the 65% rail for pricing
    expect(r.flagReseed).toBe(false);     // but the STRONG seed is trusted — listing is just over-ARV
    expect(r.basis).toBe("list_fraction_65");
    expect(r.opener).toBe(77_350);
  });

  it("an ARV at/above list is trusted (no distrust)", () => {
    const r = priceOpener({
      listPrice: 88_500,
      realArvMedian: 137_456,
      estRehabMid: 27_491,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
    });
    expect(r.arvDistrusted).toBe(false);
    expect(r.basis).toBe("arv_buybox");
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
