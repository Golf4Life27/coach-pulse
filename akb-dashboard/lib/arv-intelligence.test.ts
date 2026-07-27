import { describe, it, expect } from "vitest";
import {
  computeArvIntelligence,
  dedupeDoubleRecordedDeeds,
  dedupeDuplicateTransactionSignature,
  normalizeStreetLine,
  DEED_DUP_WINDOW_DAYS,
} from "./arv-intelligence";
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
  // Distinct addresses: identical address+price+date rows are collapsed by
  // the double-recorded-deed dedupe, as they would be in production. Prices
  // vary by $1 each so the cross-address duplicate-transaction-signature
  // dedupe (identical price+sqft+date, different addresses — the Parkdale
  // fix) doesn't ALSO collapse these; they model 4 independent sales, not
  // a bulk deed.
  const raw = [
    comp({ formattedAddress: "1 Near St", price: 150_000 }),
    comp({ formattedAddress: "2 Near St", price: 150_001 }),
    comp({ formattedAddress: "3 Near St", price: 150_002 }),
    comp({ distance: 1.4, formattedAddress: "far", price: 150_003 }),
  ];

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

describe("dedupeDoubleRecordedDeeds — one sale is one comp", () => {
  // Verbatim from 7714 E Canfield's 2026-07-20 receipts: 2431 Parker's deed
  // recorded twice, three days apart, same price — 2 of the band's "3 comps".
  const parker = (date: string): RentCastSaleComp =>
    comp({ formattedAddress: "2431 PARKER, Detroit, MI, 48214", price: 380_000, saleDate: date });

  it("collapses the double-recorded deed, keeping the latest recording", () => {
    const { comps, droppedNotes } = dedupeDoubleRecordedDeeds([
      parker("2025-07-22T00:00:00.000Z"),
      parker("2025-07-25T00:00:00.000Z"),
      comp({ formattedAddress: "3466 FISCHER, Detroit, MI, 48214", price: 462_500 }),
    ]);
    expect(comps).toHaveLength(2);
    expect(comps.find((c) => c.formattedAddress?.includes("PARKER"))!.saleDate).toBe(
      "2025-07-25T00:00:00.000Z",
    );
    expect(droppedNotes).toHaveLength(1);
    expect(droppedNotes[0]).toContain("2431 PARKER");
  });

  it("a genuine re-sale (same price, far apart) survives; different prices survive", () => {
    const farApart = dedupeDoubleRecordedDeeds([
      parker("2025-01-10T00:00:00.000Z"),
      parker("2025-07-25T00:00:00.000Z"),
    ]);
    expect(farApart.comps).toHaveLength(2);
    const differentPrice = dedupeDoubleRecordedDeeds([
      parker("2025-07-22T00:00:00.000Z"),
      comp({ formattedAddress: "2431 PARKER, Detroit, MI, 48214", price: 395_000, saleDate: "2025-07-25T00:00:00.000Z" }),
    ]);
    expect(differentPrice.comps).toHaveLength(2);
  });

  it("rows without address/price/date can't be proven duplicates — kept", () => {
    const { comps } = dedupeDoubleRecordedDeeds([
      comp({ formattedAddress: null, price: 100_000 }),
      comp({ formattedAddress: null, price: 100_000 }),
      comp({ formattedAddress: "1 X ST", price: null }),
    ]);
    expect(comps).toHaveLength(3);
  });

  it("the engine collapses dupes before band math and names them in the notes", () => {
    const subject = { zip: "48214", beds: 3, baths: 2, sqft: 1_000, condition_target: "as_is" };
    // psf uniform (~$150) and sqft inside the 0.8-1.2 ratio gate so no
    // other filter muddies the count — this test isolates the dedupe.
    // Dates are RELATIVE to the clock (not fixed calendar dates) so this
    // fixture never ages out of the engine's default recency window —
    // see the 2026-07-26 postmortem where fixed 2025-07-22/25 dates aged
    // past max_age_days and silently flipped comp_count_used from 3 to 2.
    // FISCHER/ELSEWHERE prices differ by $1 so the cross-address duplicate-
    // transaction dedupe (Parkdale fix) doesn't treat these two unrelated
    // addresses as a bulk-deed pair — they're independent sales.
    const dup = (daysAgo: number) =>
      comp({
        formattedAddress: "2431 PARKER, Detroit, MI, 48214",
        price: 165_000,
        squareFootage: 1_100,
        saleDate: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      });
    const r = computeArvIntelligence(
      [
        dup(13),
        dup(10),
        comp({ formattedAddress: "3466 FISCHER, Detroit, MI, 48214", price: 150_000 }),
        comp({ formattedAddress: "1 ELSEWHERE ST", price: 150_001 }),
      ],
      subject,
    );
    expect(r.comp_count_used).toBe(3);
    expect(r.methodology_notes.join(" ")).toContain("double-recorded");
  });
});

// ── THE 2106 PARKDALE CONTAMINATION (2026-07-27) ──────────────────────────
// recjmZd8yue8sEfhm's ARV_Comp_Details_JSON: 3 of 5 comps in the chosen
// bimodal-upper cluster were 1515 Oakwood Ave, 1526 Norwood Ave, and 1509
// Oakwood Ave — three DIFFERENT addresses sharing an IDENTICAL price
// ($840,000), sqft (1,296), and sale date, i.e. one bulk/portfolio deed
// recorded across three parcels. dedupeDoubleRecordedDeeds only catches
// same-address duplicates, so this fed the band three times and inflated
// ARV toward $740k against a true ZIP signal near $102k.
describe("dedupeDuplicateTransactionSignature — cross-address duplicate deed", () => {
  const bulkDeed = (address: string): RentCastSaleComp =>
    comp({ formattedAddress: address, price: 840_000, squareFootage: 1_296, saleDate: RECENT });

  it("collapses identical price+sqft+date rows across different addresses to one", () => {
    const { comps, droppedNotes } = dedupeDuplicateTransactionSignature([
      bulkDeed("1515 Oakwood Ave"),
      bulkDeed("1526 Norwood Ave"),
      bulkDeed("1509 Oakwood Ave"),
      comp({ formattedAddress: "40 Regular St", price: 91_000, squareFootage: 1_300 }),
    ]);
    expect(comps).toHaveLength(2);
    expect(droppedNotes).toHaveLength(2);
    expect(droppedNotes[0]).toContain("duplicate transaction signature");
  });

  it("does NOT collapse when sqft differs — price-only coincidence stays plausible", () => {
    const { comps } = dedupeDuplicateTransactionSignature([
      bulkDeed("1515 Oakwood Ave"),
      comp({ formattedAddress: "1526 Norwood Ave", price: 840_000, squareFootage: 1_450, saleDate: RECENT }),
    ]);
    expect(comps).toHaveLength(2);
  });

  it("does NOT collapse when sale dates fall outside the tolerance window", () => {
    // RECENT is 10 days ago; push far enough past it that the gap from
    // RECENT (not just from "now") exceeds the tolerance window.
    const farDate = new Date(Date.now() - (10 + DEED_DUP_WINDOW_DAYS + 5) * 86_400_000).toISOString();
    const { comps } = dedupeDuplicateTransactionSignature([
      bulkDeed("1515 Oakwood Ave"),
      comp({ formattedAddress: "1526 Norwood Ave", price: 840_000, squareFootage: 1_296, saleDate: farDate }),
    ]);
    expect(comps).toHaveLength(2);
  });

  it("rows without price/sqft/date can't be proven duplicates — kept", () => {
    const { comps } = dedupeDuplicateTransactionSignature([
      comp({ formattedAddress: "1515 Oakwood Ave", squareFootage: null }),
      comp({ formattedAddress: "1526 Norwood Ave", squareFootage: null }),
    ]);
    expect(comps).toHaveLength(2);
  });
});

describe("computeArvIntelligence — Parkdale-shaped fixture: 3 identical-triple + 2 normal comps", () => {
  it("dedupes the bulk-deed triple to one comp before band math, keeping the median sane", () => {
    const subject = { zip: "94564", beds: 3, baths: 2, sqft: 1_296, condition_target: "as_is" };
    const bulkDeed = (address: string): RentCastSaleComp =>
      comp({ formattedAddress: address, price: 840_000, squareFootage: 1_296, saleDate: RECENT });
    const raw = [
      bulkDeed("1515 Oakwood Ave"),
      bulkDeed("1526 Norwood Ave"),
      bulkDeed("1509 Oakwood Ave"),
      comp({ formattedAddress: "40 Regular St", price: 91_000, squareFootage: 1_300, saleDate: RECENT }),
      comp({ formattedAddress: "42 Regular St", price: 93_600, squareFootage: 1_300, saleDate: RECENT }),
    ];
    const r = computeArvIntelligence(raw, subject);

    // 5 raw rows collapse to 3 effective comps (1 representative + 2 normal),
    // not 5 — the duplicate-transaction signature no longer counts 3x.
    expect(r.comp_count_used).toBe(3);
    expect(r.methodology_notes.join(" ")).toContain("cross-address duplicate-transaction");

    // Un-fixed, the tripled $648/sqft row would drag avg_per_sqft to ~$417
    // (3×648.15 + 70 + 72)/5. Fixed, it's ~$263 ((648.15+70+72)/3) — still
    // pulled up by the one surviving bulk-deed comp (min_comps_for the
    // distressed-proxy outlier trim isn't met at only 3 comps), but no
    // longer triple-weighted.
    expect(r.avg_per_sqft).toBeLessThan(350);
  });
});
