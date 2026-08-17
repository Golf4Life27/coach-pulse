import { describe, expect, it } from "vitest";
import { estimateRent, fitRentModel, RENT_MODEL_DEFAULTS, type RentPoint } from "./rent-model";

// Synthetic Detroit-ish sample: rent = 30 × sqft^0.6, three ZIPs.
const mk = (zip: string, metro: string, sqft: number, noise = 1): RentPoint => ({
  zip,
  metro,
  sqft,
  rent: Math.round(30 * Math.pow(sqft, 0.6) * noise),
});

const points: RentPoint[] = [
  // 48221 — well-sampled ZIP
  mk("48221", "detroit_mi", 900), mk("48221", "detroit_mi", 1100, 1.05),
  mk("48221", "detroit_mi", 1300, 0.95), mk("48221", "detroit_mi", 1500),
  // 48223 — well-sampled ZIP
  mk("48223", "detroit_mi", 800), mk("48223", "detroit_mi", 1000, 1.1),
  mk("48223", "detroit_mi", 1200, 0.9),
  // 48238 — only 1 point: below minZipSamples, feeds the metro pool only
  mk("48238", "detroit_mi", 1000),
];

describe("fitRentModel / estimateRent", () => {
  const model = fitRentModel(points);

  it("prefers the subject's own ZIP coefficient with the ZIP haircut", () => {
    const e = estimateRent(model, { zip: "48221", metro: "detroit_mi", sqft: 1200 });
    expect(e).not.toBeNull();
    expect(e!.basis).toBe("modeled_zip");
    // ~30×1200^0.6×0.9 ≈ 1,900-ish band; assert the haircut direction, not a magic number.
    const noHaircut = e!.rent / RENT_MODEL_DEFAULTS.zipHaircut;
    expect(e!.rent).toBeLessThan(noHaircut);
  });

  it("falls back to the metro pool with the DEEPER haircut for a thin ZIP", () => {
    const e = estimateRent(model, { zip: "48238", metro: "detroit_mi", sqft: 1000 });
    expect(e).not.toBeNull();
    expect(e!.basis).toBe("modeled_metro");
    expect(e!.haircut).toBe(RENT_MODEL_DEFAULTS.metroHaircut);
  });

  it("returns null with no sqft — a size model cannot price an unsized house", () => {
    expect(estimateRent(model, { zip: "48221", metro: "detroit_mi", sqft: null })).toBeNull();
  });

  it("returns null for an unknown ZIP in an unknown metro", () => {
    expect(estimateRent(model, { zip: "99999", metro: "nowhere", sqft: 1200 })).toBeNull();
  });

  it("returns null when the prediction leaves the sane rent band", () => {
    // Absurd sqft drives the prediction over the ceiling → refuse, don't guess.
    expect(estimateRent(model, { zip: "48221", metro: "detroit_mi", sqft: 60000 })).toBeNull();
  });

  it("scales sub-linearly: doubling sqft raises rent by less than 2x", () => {
    const a = estimateRent(model, { zip: "48221", metro: "detroit_mi", sqft: 900 })!;
    const b = estimateRent(model, { zip: "48221", metro: "detroit_mi", sqft: 1800 })!;
    expect(b.rent / a.rent).toBeGreaterThan(1);
    expect(b.rent / a.rent).toBeLessThan(2);
  });
});
