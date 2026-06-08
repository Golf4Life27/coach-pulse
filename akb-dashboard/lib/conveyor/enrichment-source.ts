// Canonical enrichment-source provenance vocabulary (Station 2 ENRICH).
//
// Every structural-fact write (Building_SqFt / Bathrooms / Year_Built /
// Bedrooms) carries one of these labels in its audit entry so the
// provenance of a record's facts is queryable from the agent:audit log
// without a per-field Airtable column. Single source of truth — the
// intake mapper, the per-record backfill route, and any future
// enrichment writer all import from here rather than inlining strings.
//
// Distinct from Verification_Source (which records WHERE the listing URL
// + active-status came from: firecrawl_intake / "ScraperAPI Redfin" /
// RentCast). This label is specifically the structural-facts provenance.

export const ENRICHMENT_SOURCE = {
  /** ATTOM /property/snapshot — facts pulled from the same ZIP-discovery
   *  response the intake mapper already pays for (zero extra call). */
  ATTOM_SNAPSHOT: "attom_snapshot",
  /** RentCast subject facts — /listings/sale then /properties fallback
   *  (getSubjectFacts). The per-record backfill path. */
  RENTCAST_FACTS: "rentcast_facts",
} as const;

export type EnrichmentSource =
  (typeof ENRICHMENT_SOURCE)[keyof typeof ENRICHMENT_SOURCE];
