import { describe, it, expect } from "vitest";
import {
  sizeAdjustedPsf,
  fitPsfBySize,
  compsFromReceipts,
  MIN_COMPS_FOR_FIT,
  MIN_SLOPE_MAGNITUDE,
} from "./size-adjusted-psf";

// The real 46203 comp set that mispriced 2302 S Randolph.
const ZIP_46203 = [
  { sqft: 2737, psf: 95 }, { sqft: 2251, psf: 111 }, { sqft: 2110, psf: 121 },
  { sqft: 1904, psf: 158 }, { sqft: 1668, psf: 160 }, { sqft: 1594, psf: 185 },
  { sqft: 1428, psf: 126 }, { sqft: 1372, psf: 174 }, { sqft: 1368, psf: 121 },
  { sqft: 1299, psf: 169 }, { sqft: 1216, psf: 156 }, { sqft: 1138, psf: 171 },
];

describe("the Randolph case — the bug this exists to fix", () => {
  it("measures the size slope the seed median ignored", () => {
    const fit = fitPsfBySize(ZIP_46203)!;
    expect(fit.slope).toBeLessThan(0);
    // ~-$42 per 1,000 sqft.
    expect(fit.slope * 1000).toBeGreaterThan(-50);
    expect(fit.slope * 1000).toBeLessThan(-35);
  });

  it("prices a 790 sqft subject well above the ZIP median", () => {
    // Seed median 149 gave ARV $117,710 and pushed the record into
    // cash_no_pencil. The subject is smaller than ALL 12 comps.
    const r = sizeAdjustedPsf({ comps: ZIP_46203, subjectSqft: 790, seedMedianPsf: 149 });
    expect(r.source).toBe("size_fit");
    expect(r.psf!).toBeGreaterThan(149);
    // Clamped to the highest comp ($185) rather than extrapolating past it.
    expect(r.psf!).toBeLessThanOrEqual(185);
    expect(r.detail).toContain("seed median was $149");
  });

  it("prices a LARGE subject below the median — the bug cuts both ways", () => {
    const r = sizeAdjustedPsf({ comps: ZIP_46203, subjectSqft: 2600, seedMedianPsf: 149 });
    expect(r.source).toBe("size_fit");
    expect(r.psf!).toBeLessThan(149);
  });
});

describe("it refuses to invent a trend that is not in the data", () => {
  it("returns the seed median on too few comps", () => {
    const r = sizeAdjustedPsf({ comps: ZIP_46203.slice(0, 3), subjectSqft: 790, seedMedianPsf: 149 });
    expect(r.source).toBe("insufficient_comps");
    expect(r.psf).toBe(149);
    expect(MIN_COMPS_FOR_FIT).toBe(6);
  });

  it("returns the seed median when the slope is flat", () => {
    const flat = [900, 1100, 1300, 1500, 1700, 1900].map((sqft) => ({ sqft, psf: 100 }));
    const r = sizeAdjustedPsf({ comps: flat, subjectSqft: 790, seedMedianPsf: 100 });
    expect(r.source).toBe("seed_median");
    expect(r.psf).toBe(100);
  });

  it("returns the seed median on a POSITIVE slope rather than acting on it", () => {
    // Bigger houses selling for more per foot is not the known physical
    // relationship — far likelier a thin-data artifact than a real market.
    const inverted = [900, 1100, 1300, 1500, 1700, 1900].map((sqft, i) => ({ sqft, psf: 80 + i * 20 }));
    const r = sizeAdjustedPsf({ comps: inverted, subjectSqft: 790, seedMedianPsf: 120 });
    expect(r.source).toBe("seed_median");
    expect(r.psf).toBe(120);
    expect(r.slope!).toBeGreaterThan(0);
  });

  it("holds the slope threshold so a later edit argues with a test", () => {
    expect(MIN_SLOPE_MAGNITUDE).toBe(0.005); // $5 per 1,000 sqft
  });

  it("cannot adjust without the subject's size", () => {
    const r = sizeAdjustedPsf({ comps: ZIP_46203, subjectSqft: null, seedMedianPsf: 149 });
    expect(r.source).toBe("no_subject_sqft");
    expect(r.psf).toBe(149);
  });
});

describe("clamping — a fit outside the comps is arithmetic, not evidence", () => {
  it("never returns a psf above the highest comp", () => {
    const r = sizeAdjustedPsf({ comps: ZIP_46203, subjectSqft: 200, seedMedianPsf: 149 });
    expect(r.psf!).toBeLessThanOrEqual(Math.max(...ZIP_46203.map((c) => c.psf)));
    expect(r.clamped).toBe(true);
  });

  it("never returns a psf below the lowest comp", () => {
    const r = sizeAdjustedPsf({ comps: ZIP_46203, subjectSqft: 9_000, seedMedianPsf: 149 });
    expect(r.psf!).toBeGreaterThanOrEqual(Math.min(...ZIP_46203.map((c) => c.psf)));
    expect(r.clamped).toBe(true);
  });

  it("does not clamp a subject inside the comp band", () => {
    expect(sizeAdjustedPsf({ comps: ZIP_46203, subjectSqft: 1_600, seedMedianPsf: 149 }).clamped).toBe(false);
  });
});

describe("compsFromReceipts", () => {
  it("reads the real seed receipt shape", () => {
    const raw = JSON.stringify({
      method: "comp_cluster_unimodal",
      comps: [
        { addr: "9194 Prest St", price: 125000, sqft: 1170, psf: 107 },
        { addr: "8949 Lauder St", price: 74500, sqft: 993, psf: 75 },
      ],
    });
    expect(compsFromReceipts(raw)).toEqual([{ sqft: 1170, psf: 107 }, { sqft: 993, psf: 75 }]);
  });

  it("returns [] rather than letting a bad receipt become a confident fit", () => {
    expect(compsFromReceipts(null)).toEqual([]);
    expect(compsFromReceipts("")).toEqual([]);
    expect(compsFromReceipts("not json")).toEqual([]);
    expect(compsFromReceipts('{"comps":"nope"}')).toEqual([]);
    expect(compsFromReceipts('{"comps":[{"sqft":0,"psf":100}]}')).toEqual([]);
  });
});
