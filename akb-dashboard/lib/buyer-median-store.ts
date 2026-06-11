// ZIP-level track-aware Buyer_Median store (Buyer_Median_ZIP,
// tbleoqYRBmnJq5V0Z). @agent: appraiser/data_federation
//
// ONE SOURCE OF TRUTH PER (ZIP, TRACK). The flipper and landlord medians
// are stored as SEPARATE rows, never blended — a deal reads its ZIP's
// median for its track instead of carrying a hand-entered per-deal value.
// This is what kills per-deal Buyer_Median entry by design.
//
// Provenance is preserved, not bypassed: every row is source-stamped
// (investorbase_manual when seeded by hand from a real export,
// investorbase_auto when written by the scheduled InvestorBase pull) with
// the export date + comp count, and the auto-pull attaches the real CSV.
//
// Pure helpers are split out for tests; the I/O functions wrap the Airtable
// REST API (same pattern as lib/federation/property-intel-store.ts).

import type { BuyerTrack } from "@/lib/buyer-median-input";
import { BUYER_TRACKS } from "@/lib/buyer-median-input";

export const BUYER_MEDIAN_ZIP_TABLE = "tbleoqYRBmnJq5V0Z";

/** Fail-narrow allowlist (operator 2026-06-10): if the store read fails (e.g.
 *  the prod AIRTABLE_PAT is scoped before this table was created), callers
 *  fall back to this hardcoded set of KNOWN-SEEDED ZIPs rather than opening
 *  up to "all priceable markets per state." Keep this list in sync with the
 *  ZIPs we know are seeded — never widen it on a store-read failure.
 *  2026-06-11 expansion (spine recN7rIJ7m2gmlxKs): five Detroit ZIPs seeded
 *  from InvestorBase exports, both tracks each, read back through
 *  resolveOpenerCeiling (source=buyer_zip_store_live confirmed). */
export const FALLBACK_SEEDED_ZIPS: ReadonlySet<string> = new Set([
  "48227", // 2026-06-09 seed — landlord $55k / flipper $150k
  "48224", // 2026-06-11 — landlord $64,750 (n=38) / flipper $119,000 (n=160)
  "48219", // 2026-06-11 — landlord $77,500 (n=60) / flipper $177,000 (n=119)
  "48204", // 2026-06-11 — landlord $42,000 (n=55) / flipper $142,750 (n=82)
  "48205", // 2026-06-11 — landlord $45,000 (n=59) / flipper $103,750 (n=148)
  "48213", // 2026-06-11 — landlord $39,000 (n=43) / flipper $108,000 (n=125)
]);

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

export type ZipMedianSource = "investorbase_manual" | "investorbase_auto";
const ALLOWED_SOURCES: ReadonlySet<string> = new Set(["investorbase_manual", "investorbase_auto"]);

export interface ZipBuyerMedian {
  zip: string;
  track: BuyerTrack;
  value: number;
  source: ZipMedianSource;
  compCount: number | null;
  fetchedAt: string | null;
  recordId: string;
}

export interface ZipBuyerMedianWrite {
  zip: string;
  track: BuyerTrack;
  value: number;
  source: ZipMedianSource;
  compCount?: number | null;
  /** ISO date of the InvestorBase export. */
  fetchedAt?: string | null;
  notes?: string | null;
}

export type ZipMedianWriteValidation =
  | { ok: true; data: Required<Omit<ZipBuyerMedianWrite, "notes">> & { notes: string | null; key: string } }
  | { ok: false; error: string };

/** Pure: the composite uniqueness key for a (zip, track) row. */
export function zipMedianKey(zip: string, track: string): string {
  return `${String(zip).trim()}:${String(track).trim().toLowerCase()}`;
}

/** Pure: validate a ZIP-store write. Enforces the same hard rules as the
 *  per-deal input — a real source stamp and a non-blended track — at the
 *  store boundary so nothing un-sourced or blended is ever persisted. */
export function validateZipMedianWrite(raw: ZipBuyerMedianWrite): ZipMedianWriteValidation {
  const zip = String(raw.zip ?? "").trim();
  if (!/^\d{5}$/.test(zip)) return { ok: false, error: `zip_invalid: "${raw.zip}" is not a 5-digit ZIP` };

  const track = String(raw.track ?? "").trim().toLowerCase();
  if (!track) return { ok: false, error: "track_required: a ZIP median must declare its track" };
  if (!BUYER_TRACKS.includes(track as BuyerTrack)) {
    return { ok: false, error: `track_invalid: track must be one of ${BUYER_TRACKS.join("/")} — blended/averaged values are refused (got "${raw.track}")` };
  }

  if (!ALLOWED_SOURCES.has(String(raw.source))) {
    return { ok: false, error: `source_invalid: only investorbase_manual / investorbase_auto are accepted (got "${raw.source}")` };
  }

  const value = typeof raw.value === "number" ? raw.value : Number(String(raw.value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: "value_invalid: a positive Buyer_Median is required" };
  if (value > 5_000_000) return { ok: false, error: "value_out_of_range: exceeds sanity bound" };

  let compCount: number | null = null;
  if (raw.compCount != null) {
    const n = Number(raw.compCount);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: "comp_count_invalid: must be a non-negative integer" };
    compCount = n;
  }

  let fetchedAt: string | null = null;
  if (raw.fetchedAt != null && raw.fetchedAt !== "") {
    const t = Date.parse(String(raw.fetchedAt));
    if (!Number.isFinite(t)) return { ok: false, error: `fetched_at_invalid: "${raw.fetchedAt}" is not a parseable date` };
    fetchedAt = new Date(t).toISOString().slice(0, 10);
  }

  return {
    ok: true,
    data: {
      zip,
      track: track as BuyerTrack,
      value: Math.round(value),
      source: raw.source as ZipMedianSource,
      compCount,
      fetchedAt,
      notes: raw.notes ?? null,
      key: zipMedianKey(zip, track),
    },
  };
}

// ── Airtable I/O ────────────────────────────────────────────────────

function requirePat(): string {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");
  return AIRTABLE_PAT;
}

interface AirtableRow { id: string; fields: Record<string, unknown> }

function rowToMedian(rec: AirtableRow): ZipBuyerMedian | null {
  const f = rec.fields;
  const zip = typeof f["ZIP"] === "string" ? (f["ZIP"] as string) : null;
  const trackRaw = typeof f["Track"] === "string" ? (f["Track"] as string).toLowerCase() : null;
  const value = typeof f["Buyer_Median_Value"] === "number" ? (f["Buyer_Median_Value"] as number) : null;
  const source = typeof f["Source"] === "string" ? (f["Source"] as string) : null;
  if (!zip || (trackRaw !== "flipper" && trackRaw !== "landlord") || value == null || !ALLOWED_SOURCES.has(source ?? "")) {
    return null;
  }
  return {
    zip,
    track: trackRaw as BuyerTrack,
    value,
    source: source as ZipMedianSource,
    compCount: typeof f["Comp_Count"] === "number" ? (f["Comp_Count"] as number) : null,
    fetchedAt: typeof f["Fetched_At"] === "string" ? (f["Fetched_At"] as string) : null,
    recordId: rec.id,
  };
}

async function findRowByKey(key: string): Promise<AirtableRow | null> {
  const pat = requirePat();
  const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${BUYER_MEDIAN_ZIP_TABLE}`);
  url.searchParams.set("filterByFormula", `{Key}=${JSON.stringify(key)}`);
  url.searchParams.set("maxRecords", "1");
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${pat}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Buyer_Median_ZIP list ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: AirtableRow[] };
  return body.records?.[0] ?? null;
}

/** The set of ZIPs that have at least one seeded, positive buyer-median
 *  (either track). Loaded once per run so the priceable-market gate can
 *  stay pure. Used by the freshness re-verify + intake to confirm a market
 *  is priceable before spending Firecrawl. */
export async function listSeededZips(): Promise<Set<string>> {
  const pat = requirePat();
  const zips = new Set<string>();
  let offset: string | undefined;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${BUYER_MEDIAN_ZIP_TABLE}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${pat}` }, cache: "no-store" });
    if (!res.ok) throw new Error(`Buyer_Median_ZIP list ${res.status}: ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as { records?: AirtableRow[]; offset?: string };
    for (const rec of body.records ?? []) {
      const zip = typeof rec.fields["ZIP"] === "string" ? (rec.fields["ZIP"] as string).trim() : "";
      const value = typeof rec.fields["Buyer_Median_Value"] === "number" ? (rec.fields["Buyer_Median_Value"] as number) : 0;
      if (/^\d{5}$/.test(zip) && value > 0) zips.add(zip);
    }
    offset = body.offset;
  } while (offset);
  return zips;
}

/** Read the median for a ZIP + track. Null when none on record. */
export async function getZipBuyerMedian(zip: string | null | undefined, track: BuyerTrack): Promise<ZipBuyerMedian | null> {
  const z = String(zip ?? "").trim();
  if (!/^\d{5}$/.test(z)) return null;
  const row = await findRowByKey(zipMedianKey(z, track));
  return row ? rowToMedian(row) : null;
}

/** Upsert a (zip, track) median. Refuses un-sourced / blended writes. */
export async function upsertZipBuyerMedian(raw: ZipBuyerMedianWrite): Promise<{ recordId: string; created: boolean }> {
  const v = validateZipMedianWrite(raw);
  if (!v.ok) throw new Error(`zip_median_write_refused: ${v.error}`);
  const pat = requirePat();
  const fields: Record<string, unknown> = {
    Key: v.data.key,
    ZIP: v.data.zip,
    Track: v.data.track,
    Buyer_Median_Value: v.data.value,
    Source: v.data.source,
  };
  if (v.data.compCount != null) fields["Comp_Count"] = v.data.compCount;
  if (v.data.fetchedAt != null) fields["Fetched_At"] = v.data.fetchedAt;
  if (v.data.notes != null) fields["Notes"] = v.data.notes;

  const existing = await findRowByKey(v.data.key);
  if (existing) {
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${BUYER_MEDIAN_ZIP_TABLE}/${existing.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields, typecast: true }),
    });
    if (!res.ok) throw new Error(`Buyer_Median_ZIP patch ${res.status}: ${await res.text().catch(() => "")}`);
    return { recordId: existing.id, created: false };
  }
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${BUYER_MEDIAN_ZIP_TABLE}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!res.ok) throw new Error(`Buyer_Median_ZIP create ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: Array<{ id: string }> };
  const id = body.records?.[0]?.id;
  if (!id) throw new Error("Buyer_Median_ZIP create returned no record id");
  return { recordId: id, created: true };
}
