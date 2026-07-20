import { describe, it, expect } from "vitest";
import { computeArvIntelligence, normalizeStreetLine } from "./arv-intelligence";
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
  // Three near comps + one 1.4mi-away comp (beyond the default 1.0mi clip —
  // widened from 0.5mi per the 2026-07-20 operator distance ruling).
  const raw = [comp(), comp(), comp(), comp({ distance: 1.4, formattedAddress: "far" })];

  it("default filters clip the 1.4mi comp (1.0mi max)", () => {
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

describe("normalizeStreetLine", () => {
  it("takes the street line before the first comma, case/punctuation-insensitive", () => {
    expect(normalizeStreetLine("1122 West Ave SW, Atlanta, GA 30315")).toBe("1122 west ave sw");
    expect(normalizeStreetLine("1122 WEST AVE. SW")).toBe("1122 west ave sw");
    expect(normalizeStreetLine("  1122   West  Ave SW  ")).toBe("1122 west ave sw");
  });

  it("null/empty/whitespace → null", () => {
    expect(normalizeStreetLine(null)).toBeNull();
    expect(normalizeStreetLine(undefined)).toBeNull();
    expect(normalizeStreetLine("   ")).toBeNull();
    expect(normalizeStreetLine(", Atlanta, GA")).toBeNull();
  });
});

// ── THE 1122 WEST AVE CONTAMINATION (2026-07-17) ──────────────────────────
// RentCast's /avm/value comparables are LISTING records. The old rentcast.ts
// mapping fabricated saleDate from lastSeenDate, so three ACTIVE asking
// prices — one of them the subject property ITSELF — averaged into a
// $244,690 "ARV" on a 2/1 listed at $129,999. This suite replays that exact
// receipt trio and pins the doctrine: ARV = SOLD comps only, and a property
// is never its own comp.
describe("computeArvIntelligence — subject + active-listing exclusion", () => {
  const SUBJECT_SQFT = 1_424;
  const subject = {
    zip: "30315",
    address: "1122 West Ave SW, Atlanta, GA 30315",
    beds: 2,
    baths: 1,
    sqft: SUBJECT_SQFT,
    condition_target: "as_is",
  };

  // Post-rentcast-fix semantics: saleDate null ⇒ active listing (no sale, no
  // removal). The subject's own live ask, verbatim from the record's receipt.
  const subjectItself = comp({
    price: 129_999,
    squareFootage: 1_424,
    bedrooms: 2,
    bathrooms: 1,
    distance: 0.0067,
    daysOnMarket: 155,
    saleDate: null,
    formattedAddress: "1122 West Ave SW, Atlanta, GA 30315",
  });
  const activeDom2 = comp({
    price: 319_900,
    squareFootage: 1_500,
    bedrooms: 2,
    daysOnMarket: 2,
    saleDate: null,
    formattedAddress: "1048 Garibaldi St SW, Atlanta, GA 30310",
  });
  const soldComp = comp({
    price: 214_900,
    squareFootage: 1_400,
    bedrooms: 2,
    distance: 0.3,
    saleDate: RECENT,
    formattedAddress: "1097 Fortress Ave SW, Atlanta, GA 30315",
  });

  it("only the SOLD comp survives; subject + actives are excluded by name", () => {
    const r = computeArvIntelligence([subjectItself, activeDom2, soldComp], subject);
    expect(r.comp_count_used).toBe(1);
    expect(r.comps_used[0].formatted_address).toBe("1097 Fortress Ave SW, Atlanta, GA 30315");
    const reasons = new Map(r.comps_excluded.map((c) => [c.formatted_address, c.excluded_reason]));
    expect(reasons.get("1122 West Ave SW, Atlanta, GA 30315")).toBe("subject_property");
    expect(reasons.get("1048 Garibaldi St SW, Atlanta, GA 30310")).toBe("no_recorded_sale");
  });

  it("ARV derives from the sold $/sqft alone — the $244k fiction is dead", () => {
    const r = computeArvIntelligence([subjectItself, activeDom2, soldComp], subject);
    expect(r.arv_mid).toBe(Math.round(SUBJECT_SQFT * (214_900 / 1_400)));
    expect(r.arv_mid).toBeLessThan(244_690);
  });

  it("the subject is excluded as subject_property even when it has a sale date (prior-sale record)", () => {
    const subjectPriorSale = { ...subjectItself, saleDate: RECENT };
    const r = computeArvIntelligence([subjectPriorSale, soldComp], subject);
    expect(r.comp_count_used).toBe(1);
    const self = r.comps_excluded.find((c) => c.formatted_address === "1122 West Ave SW, Atlanta, GA 30315");
    expect(self?.excluded_reason).toBe("subject_property");
  });

  it("street-line match is punctuation/case/city-suffix tolerant", () => {
    const messy = { ...subjectItself, saleDate: RECENT, formattedAddress: "1122 WEST AVE. SW" };
    const r = computeArvIntelligence([messy, soldComp], subject);
    expect(r.comp_count_used).toBe(1);
  });

  it("no subject.address → no self-exclusion (backward compatible), actives still out", () => {
    const noAddr = { ...subject, address: undefined };
    const priorSale = { ...subjectItself, saleDate: RECENT };
    const r = computeArvIntelligence([priorSale, activeDom2, soldComp], noAddr);
    // Self-match can't fire without an address; the sold prior-sale record at
    // the subject's address is treated as an ordinary comp. Actives still die.
    expect(r.comp_count_used).toBe(2);
    const reasons = r.comps_excluded.map((c) => c.excluded_reason);
    expect(reasons).toContain("no_recorded_sale");
    expect(reasons).not.toContain("subject_property");
  });
});
