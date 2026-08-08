import { describe, it, expect } from "vitest";
import {
  validateSeedWrite,
  seedConfidence,
  arvForSubjectFromSeed,
  seedFromArvIntelligence,
  seedCompSqftBand,
  subjectOutsideCompSizeBand,
  SEED_STRONG_MIN_COMPS,
  type ZipArvSeed,
} from "./zip-arv-seed-store";
import type { ArvIntelligenceResult } from "./arv-intelligence";

describe("seedConfidence", () => {
  it("STRONG at/above the comp bar, THIN below", () => {
    expect(seedConfidence(SEED_STRONG_MIN_COMPS)).toBe("STRONG");
    expect(seedConfidence(SEED_STRONG_MIN_COMPS - 1)).toBe("THIN");
    expect(seedConfidence(0)).toBe("THIN");
  });
});

describe("validateSeedWrite", () => {
  it("accepts a sourced, positive $/sqft seed and stamps confidence", () => {
    const v = validateSeedWrite({ zip: "48227", renovatedPerSqft: 145.5, compCount: 7, source: "rentcast_avm" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.data.confidence).toBe("STRONG");
  });

  it("refuses a bad source", () => {
    const v = validateSeedWrite({ zip: "48227", renovatedPerSqft: 145, compCount: 7, source: "guess" as never });
    expect(v.ok).toBe(false);
  });

  it("refuses non-positive $/sqft and bad ZIPs", () => {
    expect(validateSeedWrite({ zip: "48227", renovatedPerSqft: 0, compCount: 7, source: "rentcast_avm" }).ok).toBe(false);
    expect(validateSeedWrite({ zip: "4822", renovatedPerSqft: 145, compCount: 7, source: "rentcast_avm" }).ok).toBe(false);
  });
});

describe("arvForSubjectFromSeed — THIN biases to the low end", () => {
  const base: ZipArvSeed = {
    zip: "48227", renovatedPerSqft: 150, arvLowPerSqft: 110, compCount: 0,
    confidence: "STRONG", dontPrice: false, source: "rentcast_avm", market: "Detroit", state: "MI",
    fetchedAt: null, receiptsJson: null, recordId: "rec1",
  };

  it("STRONG seed uses the renovated $/sqft", () => {
    expect(arvForSubjectFromSeed({ ...base, confidence: "STRONG" }, 1000)).toBe(150_000);
  });

  it("THIN seed uses the LOW-end $/sqft (conservative)", () => {
    expect(arvForSubjectFromSeed({ ...base, confidence: "THIN" }, 1000)).toBe(110_000);
  });

  it("THIN with no low-end falls back to the renovated $/sqft", () => {
    expect(arvForSubjectFromSeed({ ...base, confidence: "THIN", arvLowPerSqft: null }, 1000)).toBe(150_000);
  });

  it("null sqft → null", () => {
    expect(arvForSubjectFromSeed(base, null)).toBeNull();
  });

  it("DONT_PRICE seed → null even with sqft + a positive $/sqft on the row", () => {
    expect(arvForSubjectFromSeed({ ...base, confidence: "DONT_PRICE", dontPrice: true }, 1000)).toBeNull();
  });

  it("STRONG seed WITH comp receipts uses size-adjusted sales comparison, not flat $/sqft", () => {
    // Comps ~1,000 sqft; a 2,000 sqft subject. Flat $/sqft (150×2000=300k) would
    // over-price; comp-adjustment must come in below that.
    const receipts = JSON.stringify({
      comps: [
        { price: 150_000, sqft: 1_000 }, { price: 150_000, sqft: 1_000 },
        { price: 150_000, sqft: 1_000 }, { price: 150_000, sqft: 1_000 },
        { price: 150_000, sqft: 1_000 },
      ],
    });
    const arv = arvForSubjectFromSeed({ ...base, confidence: "STRONG", renovatedPerSqft: 150, receiptsJson: receipts }, 2_000);
    expect(arv).not.toBeNull();
    expect(arv!).toBeLessThan(300_000); // sub-linear, not 150 × 2000
  });

  it("STRONG seed with too FEW comps falls back to flat $/sqft", () => {
    const receipts = JSON.stringify({ comps: [{ price: 150_000, sqft: 1_000 }, { price: 150_000, sqft: 1_000 }] });
    expect(arvForSubjectFromSeed({ ...base, confidence: "STRONG", renovatedPerSqft: 150, receiptsJson: receipts }, 1_000)).toBe(150_000);
  });
});

describe("validateSeedWrite — DONT_PRICE sentinel", () => {
  it("accepts a dont-price write with no $/sqft and stamps DONT_PRICE", () => {
    const v = validateSeedWrite({ zip: "48205", dontPrice: true, compCount: 1, source: "rentcast_avm" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.data.confidence).toBe("DONT_PRICE");
      expect(v.data.renovatedPerSqft).toBe(0);
      expect(v.data.dontPrice).toBe(true);
    }
  });

  it("still enforces a valid ZIP + source on a dont-price write", () => {
    expect(validateSeedWrite({ zip: "4820", dontPrice: true, compCount: 0, source: "rentcast_avm" }).ok).toBe(false);
    expect(validateSeedWrite({ zip: "48205", dontPrice: true, compCount: 0, source: "guess" as never }).ok).toBe(false);
  });
});

describe("seedFromArvIntelligence", () => {
  function arvResult(over: Partial<ArvIntelligenceResult> = {}): ArvIntelligenceResult {
    return {
      zip: "48227", subject: { zip: "48227" }, condition_target_resolved: "renovated",
      data_state_default: "as_is", market: "Detroit",
      arv_as_is: { low: null, mid: null, high: null, method: null },
      arv_renovated: { low: null, mid: null, high: null, method: null },
      arv_mid: 212_000, arv_low: 180_000, arv_high: 240_000, arv_method: "comp_cluster_bimodal_upper",
      cross_method_disagreement: { fired: false, cluster_mid: null, uplift_mid: null, delta_pct: null, threshold_pct: 0.1 },
      avg_per_sqft: 145, comp_count_raw: 18, comp_count_used: 7, comp_count_excluded: 11,
      confidence: "HIGH", confidence_score: 85,
      comps_used: [
        { price: 200_000, sqft: 1400, per_sqft: 143, distance: 0.3, sale_date: "2026-03-01", beds: 3, bathrooms: 2, days_on_market: 20, formatted_address: "1 A St" },
        { price: 210_000, sqft: 1400, per_sqft: 150, distance: 0.5, sale_date: "2026-02-01", beds: 3, bathrooms: 2, days_on_market: 30, formatted_address: "2 B St" },
      ],
      comps_excluded: [], methodology_notes: [], filter_quality: "clean", computed_at: "2026-06-14T00:00:00Z",
      ...over,
    };
  }

  it("derives a seed write from the renovated headline $/sqft + low-end + receipts", () => {
    const w = seedFromArvIntelligence(arvResult(), "rentcast_avm", { state: "MI" });
    expect(w).not.toBeNull();
    expect(w!.renovatedPerSqft).toBe(145);
    expect(w!.arvLowPerSqft).toBe(143); // min per_sqft of comps_used
    expect(w!.compCount).toBe(7);
    expect(w!.state).toBe("MI");
    expect(w!.receiptsJson).toContain("comps");
  });

  it("returns null when no usable $/sqft", () => {
    expect(seedFromArvIntelligence(arvResult({ avg_per_sqft: null }), "rentcast_avm")).toBeNull();
  });
});

describe("size-extrapolation guard (927 Avon St, 2026-07-23)", () => {
  const receipts = (sqfts: number[]) =>
    JSON.stringify({ method: "comp_cluster_unimodal", comps: sqfts.map((sqft) => ({ addr: "x", sqft, psf: 100 })) });

  it("seedCompSqftBand reads the min/max/count from receipts", () => {
    expect(seedCompSqftBand({ receiptsJson: receipts([978, 1236, 991, 1040]) })).toEqual({ min: 978, max: 1236, count: 4 });
  });

  it("seedCompSqftBand is null with no receipts (older seeds are not guarded)", () => {
    expect(seedCompSqftBand({ receiptsJson: null })).toBeNull();
    expect(seedCompSqftBand({ receiptsJson: "not json" })).toBeNull();
    expect(seedCompSqftBand({ receiptsJson: JSON.stringify({ comps: [] }) })).toBeNull();
  });

  it("flags a subject 2.1× the largest comp as outside the band (the Avon case)", () => {
    const v = subjectOutsideCompSizeBand({ receiptsJson: receipts([978, 1236, 991, 1040]) }, 2605);
    expect(v.outside).toBe(true);
    expect(v.band).toEqual({ min: 978, max: 1236, count: 4 });
  });

  it("passes a subject inside the band", () => {
    expect(subjectOutsideCompSizeBand({ receiptsJson: receipts([978, 1236, 991, 1040]) }, 1100).outside).toBe(false);
    // exactly at 1.5× the max is the boundary (not outside)
    expect(subjectOutsideCompSizeBand({ receiptsJson: receipts([1000]) }, 1500).outside).toBe(false);
    expect(subjectOutsideCompSizeBand({ receiptsJson: receipts([1000]) }, 1501).outside).toBe(true);
  });

  it("flags a subject far below the smallest comp", () => {
    expect(subjectOutsideCompSizeBand({ receiptsJson: receipts([1000, 1200]) }, 600).outside).toBe(true);
  });

  it("does not block when there is nothing to judge against", () => {
    expect(subjectOutsideCompSizeBand({ receiptsJson: null }, 2605).outside).toBe(false);
    expect(subjectOutsideCompSizeBand({ receiptsJson: receipts([1000]) }, null).outside).toBe(false);
  });
});

describe("arvForSubjectFromSeed — measured slope beats assumed curve (2026-08-08)", () => {
  // The two real mispricings this ladder exists to stop. Both subjects were
  // SMALLER than every comp in their seed, and both priced too low:
  //   2302 S Randolph  — walked away from; comps later shown to sell OVER ask.
  //   2175 W 106th St  — $25,750 sent on an $89k ask; agent rejected outright.
  const base: ZipArvSeed = {
    zip: "44102", renovatedPerSqft: 75, arvLowPerSqft: 55, compCount: 10,
    confidence: "STRONG", dontPrice: false, source: "rentcast_avm", market: "Cleveland", state: "OH",
    fetchedAt: null, receiptsJson: null, recordId: "rec1",
  };
  const w106 = JSON.stringify({
    comps: [
      { price: 149_900, sqft: 2_710 }, { price: 184_900, sqft: 2_337 }, { price: 150_000, sqft: 2_128 },
      { price: 149_999, sqft: 1_658 }, { price: 129_900, sqft: 2_040 }, { price: 125_000, sqft: 1_889 },
      { price: 124_900, sqft: 1_896 }, { price: 160_000, sqft: 2_091 }, { price: 149_900, sqft: 1_848 },
      { price: 199_000, sqft: 1_964 },
    ],
  });

  it("2175 W 106th: a 1,258 sqft subject prices off the ZIP's own slope, not the assumed curve", () => {
    const arv = arvForSubjectFromSeed({ ...base, receiptsJson: w106 }, 1_258)!;
    // Flat was $94,350; the assumed curve gave ~$107k; the measured slope,
    // clamped to the comp psf range, gives ~$118.5k.
    expect(arv).toBeGreaterThan(115_000);
    expect(arv).toBeLessThan(122_000);
  });

  it("cuts BOTH ways: a subject larger than the comps prices BELOW flat", () => {
    const arv = arvForSubjectFromSeed({ ...base, receiptsJson: w106 }, 3_000)!;
    expect(arv).toBeLessThan(75 * 3_000);
  });

  it("flat-psf comps (no slope) fall back to the assumed curve, not the fit", () => {
    // Every comp the same $/sqft — no measurable size relationship. The fit
    // must refuse and hand off rather than invent a trend.
    const flat = JSON.stringify({
      comps: [1_000, 1_200, 1_400, 1_600, 1_800, 2_000].map((sqft) => ({ price: 100 * sqft, sqft })),
    });
    const arv = arvForSubjectFromSeed({ ...base, renovatedPerSqft: 100, receiptsJson: flat }, 800)!;
    // Sub-linear curve on flat-psf comps: above flat for a small subject, but
    // NOT the runaway a forced fit could produce.
    expect(arv).toBeGreaterThan(80_000);
    expect(arv).toBeLessThan(100_000);
  });
});
