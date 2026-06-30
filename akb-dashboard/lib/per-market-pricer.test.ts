import { describe, it, expect } from "vitest";
import { priceOpener, NEVER_OVER_LIST_PCT } from "./per-market-pricer";

const DETROIT_BUYBOX = 0.6461;

describe("priceOpener — value-anchored buy-box path (the only SEND basis)", () => {
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
    expect(r.opener).toBe(84_750); // 94,220 × 0.90 = 84,798 → nearest $250
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

  it("buy-box that does NOT pencil (rehab eats it) HOLDS — never falls to a list fraction", () => {
    // ceiling = 50000×0.6461 − 40000 − 5000 = negative → 0 → non-penciling.
    // OLD doctrine sent 0.65 × 80000 = $52,000 (list-anchored). NEW: HOLD.
    const r = priceOpener({
      realArvMedian: 50_000,
      estRehabMid: 40_000,
      wholesaleFee: 5_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
      listPrice: 80_000,
    });
    expect(r.basis).toBe("hold_no_value_basis");
    expect(r.confidence).toBe("NONE");
    expect(r.opener).toBeNull(); // was 52_000
  });
});

describe("priceOpener — no value basis HOLDS (the list-fraction fallback is RETIRED, 2026-06-28)", () => {
  it("no ARV → HOLD, NOT a fraction of list (the Blackmoor $84.5k bug)", () => {
    const r = priceOpener({ listPrice: 100_000 });
    expect(r.basis).toBe("hold_no_value_basis");
    expect(r.opener).toBeNull(); // was 0.65 × 100000 = 65,000
    expect(r.confidence).toBe("NONE");
  });

  it("no ARV regardless of anchor — the list price never produces a number", () => {
    const at90 = priceOpener({ listPrice: 120_000, anchorPct: 0.90 });
    const at80 = priceOpener({ listPrice: 120_000, anchorPct: 0.80 });
    expect(at90.opener).toBeNull(); // was 78,000
    expect(at80.opener).toBeNull(); // was 78,000
    expect(at90.basis).toBe("hold_no_value_basis");
  });

  it("HOLDS when arv_pct_max is absent even if an ARV exists (no sourced buy-box → cannot value-anchor)", () => {
    const r = priceOpener({ realArvMedian: 200_000, listPrice: 100_000, arvPctMax: null });
    expect(r.basis).toBe("hold_no_value_basis");
    expect(r.opener).toBeNull(); // was 65,000
  });
});

describe("GUARD A — never-over-list cap (Hole A) — clamps a VALUE-anchored opener", () => {
  it("clamps an over-list opener down to the list price and flags re-seed", () => {
    // 14299 Kilbourne: garbage-high ARV → opener would be ~$87,882 on a
    // $47,900 list. Must cap to list, never over asking. (The cap only bites
    // when ARV ≫ list — a deep-discount listing — so it is safe, NOT the
    // retired list-fraction fallback.)
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

describe("GUARD B — low-opener floor (Hole B) — HOLDS a micro-opener", () => {
  it("HOLDS a sub-floor buy-box micro-opener (never routes to a list fraction)", () => {
    // 16093 Liberal: ARV $72,518 (> list, so sanity passes) but $39,950
    // rehab squeezes the ceiling → ~$1,714 opener < floor. OLD: 0.65 × 20000 =
    // $13,000 (list-anchored). NEW: HOLD for operator review.
    const r = priceOpener({
      listPrice: 20_000,
      realArvMedian: 72_518,
      estRehabMid: 39_950,
      wholesaleFee: 5_000,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
    });
    expect(r.flooredToFallback).toBe(true);
    expect(r.basis).toBe("hold_no_value_basis");
    expect(r.opener).toBeNull(); // was 13_000
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
    expect(r.opener).toBe(50_750); // 56,319 × 0.90 = 50,687 → nearest $250
  });
});

describe("GUARD C — ARV-sanity gate (Hole C) — HOLDS a below-list ARV", () => {
  it("distrusts a below-list ARV and HOLDS (never list-anchors), flags re-seed", () => {
    // 15509 Lauder: ARV $93,818 < list $119,000 → as-is/wrong-basis. OLD:
    // 0.65 × 119000 = $77,350 (list-anchored). NEW: HOLD.
    const r = priceOpener({
      listPrice: 119_000,
      realArvMedian: 93_818,
      estRehabMid: 34_425,
      arvPctMax: DETROIT_BUYBOX,
      anchorPct: 0.90,
    });
    expect(r.arvDistrusted).toBe(true);
    expect(r.flagReseed).toBe(true);
    expect(r.basis).toBe("hold_no_value_basis");
    expect(r.opener).toBeNull(); // was 77_350
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
    expect(r.arvDistrusted).toBe(true);   // still HOLDS (never list-anchors)
    expect(r.flagReseed).toBe(false);     // but the STRONG seed is trusted — listing is just over-ARV
    expect(r.basis).toBe("hold_no_value_basis");
    expect(r.opener).toBeNull();
  });

  it("an ARV at/above list is trusted (no distrust) → value-anchored opener", () => {
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
  it("no ARV and no list → opener null, basis hold_no_value_basis", () => {
    const r = priceOpener({});
    expect(r.opener).toBeNull();
    expect(r.basis).toBe("hold_no_value_basis");
    expect(r.confidence).toBe("NONE");
  });
});
