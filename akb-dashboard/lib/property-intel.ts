// INV-022 — Property_Intel federation table: IDs, types, field map.
// @agent: appraiser / data_federation
//
// Sprint 1 (schema + types only — NO network calls, NO Airtable read/write
// helpers; those land in Sprint 2). This module is the single source of
// truth for the Property_Intel table provisioned 2026-05-25
// (table id tbllf0GNjYepvnUuv on base appp8inLAGTg4qpEZ).
//
// Per-field provenance discipline (Decision Preconditions): every hydrated
// datum carries value + source + fetched_at. A field with no *_Source set
// is unhydrated, never guessed (fabrication prohibition).
//
// The 7 RESERVED_INV_028 fields are created empty at v1 provisioning so
// INV-028 (Firecrawl wiring) needs no schema migration when it ships.

export const PROPERTY_INTEL_TABLE = "tbllf0GNjYepvnUuv";

/** propName → Airtable field ID. Mirrors the LISTING_FIELDS pattern in
 *  lib/airtable.ts. Sprint 2 write path uses these for precise PATCH. */
export const PROPERTY_INTEL_FIELD_IDS = {
  subjectAddress: "fldKCG9eQbaChi7HN", // primary
  subjectListingId: "fldPpatNuvxxrsXvb", // link → Listings_V1
  hydrationStatus: "fldu64ajBVLRZnWwQ",
  lastHydratedAt: "fldtbHr5qQ1rlY0Ke",
  // Valuation (RentCast /avm/value)
  asIsValue: "fldy4uLT3PjdxMOAJ",
  asIsValueLow: "fldTf7ckk43lMEpMv",
  asIsValueHigh: "fld4Cc0lav2ZKdQsv",
  asIsValueSource: "fldRI1OTSHTzEeuXK",
  asIsValueFetchedAt: "fldjrHkBBmdI3qRiK",
  // Rent (RentCast /avm/rent/long-term)
  rentEstimate: "fldLTJvZ3FWUUsjs1",
  rentEstimateSource: "fldGNEWJEEcD7xL0b",
  rentEstimateFetchedAt: "fldIZFiIo85GT5F0N",
  // Comps (embedded in /avm/value)
  soldCompsJson: "fld9hXnoPbws2AO6n",
  soldCompsCount: "fldJWKSbhSJ6i5Kmw",
  // Photos (ScraperAPI listing + Street View, via collectPhotos) — Sprint 2
  photoUrlsJson: "fldgFwAinHgzVa6Op",
  photoCount: "fldfxDOcY9z2gKCK5",
  photosSource: "fld1lQrNX3TGWqy0P",
  photosFetchedAt: "fldYxO1ZulSMVtnIn",
  // Buyer demand (InvestorBase — v2)
  buyerMedianValue: "fldCltGNla5PU6uwa",
  buyerMedianSource: "fldJFeiWWnrndbF9e",
  buyerMedianSampleSize: "fldiBDQrsEsLGdTlr",
  buyerMedianFetchedAt: "fldHu1vxVeas7afW6",
  // Title + liens (PropStream — v2; feeds INV-023)
  ownerOfRecord: "fld5mTiDc3imKliVW",
  ownerSource: "fldp52SqY812t9wxt",
  ownerFetchedAt: "fldn9XufPVbvzd8q6",
  firstMortgageAmount: "fldv3KAm5Ch79pzzB",
  firstMortgageType: "fldSStvuuPjA9lSLh",
  secondMortgageAmount: "fldDYOpwDVqZxsgpt",
  judgmentLiensTotal: "fldgZ7iwVurzYM0M3",
  mechanicLiensTotal: "fld5QTGBqWik2dRvF",
  taxLiensTotal: "fldOXOtVXSL9L8BV9",
  payoffTotal: "fld1YAqMCxYlBUQO8",
  liensSource: "fldvGPEiuSyhF5Sjj",
  liensFetchedAt: "fldyGYiohwgjgh5yj",
  // Flood + crime
  femaFloodZone: "fldbSugqHlQu3ox31",
  femaFloodSource: "fld8Fz3zqPlTs0EQ5",
  femaFloodFetchedAt: "fldlz85mohiCdyVEz",
  crimeGrade: "fldeioAX1LqUxSoj5",
  crimeGradeSource: "fldNaof9kELMfXeFw",
  crimeGradeFetchedAt: "fldMr2F2bPWUhijfb",
  // Discrepancy surface (Q5)
  discrepancyFlagsJson: "fld4O0zWl4LclWXQL",
  discrepancySeverityMax: "fldP78qE6Eru2XFjc",
  // RESERVED for INV-028 (Firecrawl, v2)
  listingFlipScore: "fldH9dmBWfWEX0TFT",
  listingFlipBucket: "fldXFCVsAblKfELw8",
  offMarketBodyTextDetected: "fldA6JbDIR0kQl0HU",
  restrictionRiskLevel: "fld19cX4MKGpqZC6E",
  domDiscrepancyDays: "fldD8xzWOqefMkWjf",
  listingContentSource: "fldywQM1lxd4wp97E",
  listingContentFetchedAt: "fldoE5nnb7vAzedOK",
} as const;

export type PropertyIntelFieldKey = keyof typeof PROPERTY_INTEL_FIELD_IDS;

// ── Provenance + value types ────────────────────────────────────────

export type VendorSource =
  | "rentcast"
  | "investorbase"
  | "propstream"
  | "fema_nfhl"
  | "crimeometer"
  | "doorprofit"
  | "crimegrade"
  | "neighborhoodscout"
  | "firecrawl"
  | "scraperapi"
  | "streetview"
  | "mixed"
  | "manual_operator";

export type HydrationStatus = "pending" | "partial" | "complete" | "failed";

export type MortgageType = "fixed" | "revolving" | "unknown";

export type DiscrepancySeverity = "none" | "info" | "amber" | "red";

/** A single hydrated datum + its provenance. fetchedAt is ISO 8601. */
export interface Provenanced<T> {
  value: T;
  source: VendorSource;
  fetchedAt: string;
}

/** Lien inputs PropStream hydration produces (v2). All currency, USD. */
export interface LienInputs {
  firstMortgageAmount?: number | null;
  secondMortgageAmount?: number | null;
  judgmentLiensTotal?: number | null;
  mechanicLiensTotal?: number | null;
  taxLiensTotal?: number | null;
}

export interface DiscrepancyFlag {
  type:
    | "owner_mismatch"
    | "lien_presence"
    | "flood_zone"
    | "crime_grade_drop"
    | "price_drift"
    | "memphis_assignment";
  severity: DiscrepancySeverity;
  detail: string;
  detected_at: string;
}
