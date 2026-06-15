import { describe, it, expect } from "vitest";
import { computeArvIntelligence } from "./arv-intelligence";
import type { RentCastSaleComp } from "./rentcast";

// A sale 10 days ago — inside both the default 90d window and the widened 365d.
const RECENT = new Date(Date.now() - 10 * 86_400_000).toISOString();

function comp(over: Partial<RentCastSaleComp> = {}): RentCastSaleComp {
  return {
    price: 150_000,
    squareFootage: 1_000, // psf 150 — uniform so no dispersion trim fires
    bedrooms: 3,
    bathrooms: 2,
    yearBuilt: 1950,
    distance: 0.2,
    daysOnMarket: 20,
    removedDate: null,
    saleDate: RECENT,
    formattedAddress: "comp",
    ...over,
  };
}

describe("computeArvIntelligence — per-call filter override (seed widen)", () => {
  const subject = { zip: "48205", beds: 3, baths: 2, sqft: 1_000, condition_target: "as_is" };
  // Three near comps + one 1.0mi-away comp (beyond the default 0.5mi clip).
  const raw = [comp(), comp(), comp(), comp({ distance: 1.0, formattedAddress: "far" })];

  it("default filters clip the 1.0mi comp (0.5mi max)", () => {
    const r = computeArvIntelligence(raw, subject);
    expect(r.comp_count_used).toBe(3);
  });

  it("widened override (2mi radius) keeps the far comp", () => {
    const r = computeArvIntelligence(raw, subject, {
      filterOverride: {
        comp_filters: { max_distance_miles: 2, max_age_days: 365, beds_exact_match_required: false, sqft_ratio_min: 0.6, sqft_ratio_max: 1.5 },
        distressed_proxy: { apply_only_if_zip_has_at_least_comps: 3 },
      },
    });
    expect(r.comp_count_used).toBe(4);
  });

  it("no override leaves global behavior byte-for-byte unchanged", () => {
    const a = computeArvIntelligence(raw, subject);
    const b = computeArvIntelligence(raw, subject, {});
    expect(a.comp_count_used).toBe(b.comp_count_used);
    expect(a.avg_per_sqft).toBe(b.avg_per_sqft);
  });
});
