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
