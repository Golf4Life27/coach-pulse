// INV-022 Sprint 2 — Property_Intel persistence + pure field assembler.
// @agent: data_federation
//
// Airtable I/O for the Property_Intel table (tbllf0GNjYepvnUuv). The
// federation cron (Sprint 3) calls upsertPropertyIntel after the vendor
// hydrators (rentcast-hydrate, scraperapi-hydrate, fema-flood) produce
// their provenance-tagged contributions.
//
// Idempotency: one Property_Intel row per Listings_V1 record, matched on
// the Subject_Listing_Id link. v1 scale (dozens of active DD records) makes
// an in-code match acceptable; revisit if Property_Intel grows large.
//
// Per-field provenance: buildHydrationFields emits ONLY the fields a vendor
// actually hydrated. A field never written stays null = unhydrated, never
// guessed (fabrication prohibition).

import {
  PROPERTY_INTEL_TABLE,
  type DiscrepancyFlag,
  type DiscrepancySeverity,
  type HydrationStatus,
  type VendorSource,
} from "@/lib/property-intel";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

const JSON_FIELD_CAP = 95_000;

// ── Contribution shapes (vendor hydrators produce these) ────────────

export interface ValuationContribution {
  asIsValue: number | null;
  asIsValueLow: number | null;
  asIsValueHigh: number | null;
  source: VendorSource;
  fetchedAt: string;
}

export interface RentContribution {
  rent: number | null;
  source: VendorSource;
  fetchedAt: string;
}

export interface CompsContribution {
  comps: unknown[];
  source: VendorSource;
}

export interface PhotoContribution {
  /** [{url, source}] */
  photos: Array<{ url: string; source: string }>;
  source: VendorSource;
  fetchedAt: string;
}

export interface FloodContribution {
  zone: string | null;
  source: VendorSource;
  fetchedAt: string;
}

export interface DiscrepancyContribution {
  flags: DiscrepancyFlag[];
  severityMax: DiscrepancySeverity;
}

export interface HydrationContribution {
  valuation?: ValuationContribution;
  rent?: RentContribution;
  comps?: CompsContribution;
  photos?: PhotoContribution;
  flood?: FloodContribution;
  discrepancy?: DiscrepancyContribution;
  hydrationStatus?: HydrationStatus;
  lastHydratedAt?: string;
}

/** Pure: map a hydration contribution to an Airtable-name-keyed payload.
 *  Only present contributions emit fields. JSON fields are capped. */
export function buildHydrationFields(
  c: HydrationContribution,
): Record<string, unknown> {
  const f: Record<string, unknown> = {};

  if (c.valuation) {
    if (c.valuation.asIsValue != null) f["AS_IS_Value"] = c.valuation.asIsValue;
    if (c.valuation.asIsValueLow != null) f["AS_IS_Value_Low"] = c.valuation.asIsValueLow;
    if (c.valuation.asIsValueHigh != null) f["AS_IS_Value_High"] = c.valuation.asIsValueHigh;
    f["AS_IS_Value_Source"] = c.valuation.source;
    f["AS_IS_Value_FetchedAt"] = c.valuation.fetchedAt;
  }

  if (c.rent) {
    if (c.rent.rent != null) f["Rent_Estimate"] = c.rent.rent;
    f["Rent_Estimate_Source"] = c.rent.source;
    f["Rent_Estimate_FetchedAt"] = c.rent.fetchedAt;
  }

  if (c.comps) {
    f["Sold_Comps_JSON"] = JSON.stringify(c.comps.comps).slice(0, JSON_FIELD_CAP);
    f["Sold_Comps_Count"] = c.comps.comps.length;
  }

  if (c.photos) {
    f["Photo_Urls_JSON"] = JSON.stringify(c.photos.photos).slice(0, JSON_FIELD_CAP);
    f["Photo_Count"] = c.photos.photos.length;
    f["Photos_Source"] = c.photos.source;
    f["Photos_FetchedAt"] = c.photos.fetchedAt;
  }

  if (c.flood) {
    if (c.flood.zone != null) f["FEMA_Flood_Zone"] = c.flood.zone;
    f["FEMA_Flood_Source"] = c.flood.source;
    f["FEMA_Flood_FetchedAt"] = c.flood.fetchedAt;
  }

  if (c.discrepancy) {
    f["Discrepancy_Flags_JSON"] = JSON.stringify(c.discrepancy.flags).slice(0, JSON_FIELD_CAP);
    f["Discrepancy_Severity_Max"] = c.discrepancy.severityMax;
  }

  if (c.hydrationStatus) f["Hydration_Status"] = c.hydrationStatus;
  if (c.lastHydratedAt) f["Last_Hydrated_At"] = c.lastHydratedAt;

  return f;
}

// ── Airtable I/O ────────────────────────────────────────────────────

function requirePat(): string {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");
  return AIRTABLE_PAT;
}

interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

/** Find the Property_Intel row linked to a given Listings_V1 record id.
 *  Matches the Subject_Listing_Id link array in-code (v1 scale). Returns
 *  the Property_Intel record id, or null if none exists yet. */
export async function findPropertyIntelByListing(
  listingId: string,
): Promise<string | null> {
  const pat = requirePat();
  let offset: string | undefined;
  do {
    const url = new URL(
      `https://api.airtable.com/v0/${BASE_ID}/${PROPERTY_INTEL_TABLE}`,
    );
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${pat}` },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Property_Intel list ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const body = (await res.json()) as { records?: AirtableRecord[]; offset?: string };
    for (const rec of body.records ?? []) {
      const link = rec.fields["Subject_Listing_Id"];
      if (Array.isArray(link) && link.includes(listingId)) {
        return rec.id;
      }
    }
    offset = body.offset;
  } while (offset);
  return null;
}

/** Create a Property_Intel row linked to a listing. Returns new record id. */
export async function createPropertyIntel(
  listingId: string,
  subjectAddress: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const pat = requirePat();
  const url = `https://api.airtable.com/v0/${BASE_ID}/${PROPERTY_INTEL_TABLE}`;
  const payload = {
    records: [
      {
        fields: {
          Subject_Address: subjectAddress,
          Subject_Listing_Id: [listingId],
          ...fields,
        },
      },
    ],
    typecast: true,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Property_Intel create ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { records?: Array<{ id: string }> };
  const id = body.records?.[0]?.id;
  if (!id) throw new Error("Property_Intel create returned no record id");
  return id;
}

/** Patch an existing Property_Intel row. */
export async function updatePropertyIntelRecord(
  recordId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const pat = requirePat();
  const url = `https://api.airtable.com/v0/${BASE_ID}/${PROPERTY_INTEL_TABLE}/${recordId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    throw new Error(`Property_Intel patch ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

/** Find-or-create then patch. The single entry point the cron uses. */
export async function upsertPropertyIntel(
  listingId: string,
  subjectAddress: string,
  fields: Record<string, unknown>,
): Promise<{ recordId: string; created: boolean }> {
  const existing = await findPropertyIntelByListing(listingId);
  if (existing) {
    await updatePropertyIntelRecord(existing, fields);
    return { recordId: existing, created: false };
  }
  const recordId = await createPropertyIntel(listingId, subjectAddress, fields);
  return { recordId, created: true };
}
