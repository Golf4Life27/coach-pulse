// ZIP-level renovated-ARV $/sqft seed cache (ZIP_ARV_Seed,
// tblduJzD1gShaGDQQ). @agent: appraiser/scout
//
// THE COST LEVER for the national crawler (Maverick 2026-06-14). A ZIP's
// renovated $/sqft is pulled ONCE (one comp pull = one paid call), cached
// here, then EVERY listing in that ZIP prices its rough ARV for free:
//   rough_ARV = stored_renovated_$psf × subject_sqft.
// That is what keeps crawl-volume pricing in the lean band — paid calls
// scale with NEW ZIP SEEDS/day (clamped by DAILY_INTAKE_BUDGET_USD), not
// with listings/day.
//
// DISTINCT FROM Buyer_Median_ZIP (ruling #2, Maverick 2026-06-14): that
// store holds buyer PURCHASE medians (InvestorBase, disclosure states);
// this holds ARV RESALE $/sqft (comp-derived). They are two different
// economic quantities and must NEVER be blended into one field — the exact
// conflation the keystone rewrite cured. Separate table, separate lib.
//
// CONFIDENCE: STRONG (≥5 clean comps) → use the renovated $/sqft directly.
// THIN (<5) → the pricer biases to the LOW end (Arv_Low_PerSqft), never the
// median, per the spec's thin-data conservatism. Every row carries its comp
// receipts so any seed is operator-verifiable in one click.
//
// Pure helpers split out for tests; I/O wraps the Airtable REST API (same
// pattern as lib/buyer-median-store.ts).

import type { ArvIntelligenceResult } from "@/lib/arv-intelligence";

export const ZIP_ARV_SEED_TABLE = "tblduJzD1gShaGDQQ";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

/** ≥ this many clean comps in the seed → STRONG; fewer → THIN. */
export const SEED_STRONG_MIN_COMPS = 5;

export type SeedConfidence = "STRONG" | "THIN";
export type SeedSource = "rentcast_avm" | "attom_salescomparables";
const ALLOWED_SOURCES: ReadonlySet<string> = new Set(["rentcast_avm", "attom_salescomparables"]);

export interface ZipArvSeed {
  zip: string;
  renovatedPerSqft: number;
  arvLowPerSqft: number | null;
  compCount: number;
  confidence: SeedConfidence;
  source: SeedSource;
  market: string | null;
  state: string | null;
  fetchedAt: string | null;
  receiptsJson: string | null;
  recordId: string;
}

export interface ZipArvSeedWrite {
  zip: string;
  renovatedPerSqft: number;
  arvLowPerSqft?: number | null;
  compCount: number;
  source: SeedSource;
  market?: string | null;
  state?: string | null;
  fetchedAt?: string | null;
  receiptsJson?: string | null;
}

export type SeedWriteValidation =
  | { ok: true; data: ZipArvSeedWrite & { confidence: SeedConfidence; key: string } }
  | { ok: false; error: string };

/** Pure: one row per ZIP. */
export function zipArvSeedKey(zip: string): string {
  return String(zip).trim();
}

/** Pure: STRONG iff comp count clears the bar. */
export function seedConfidence(compCount: number): SeedConfidence {
  return compCount >= SEED_STRONG_MIN_COMPS ? "STRONG" : "THIN";
}

/** Pure: validate a seed write at the store boundary — refuses anything
 *  un-sourced or with a non-positive $/sqft so no junk seed can be cached. */
export function validateSeedWrite(raw: ZipArvSeedWrite): SeedWriteValidation {
  const zip = String(raw.zip ?? "").trim();
  if (!/^\d{5}$/.test(zip)) return { ok: false, error: `zip_invalid: "${raw.zip}" is not a 5-digit ZIP` };

  if (!ALLOWED_SOURCES.has(String(raw.source))) {
    return { ok: false, error: `source_invalid: only rentcast_avm / attom_salescomparables accepted (got "${raw.source}")` };
  }

  const psf = Number(raw.renovatedPerSqft);
  if (!Number.isFinite(psf) || psf <= 0) return { ok: false, error: "renovated_per_sqft_invalid: a positive $/sqft is required" };
  if (psf > 5_000) return { ok: false, error: "renovated_per_sqft_out_of_range: exceeds sanity bound ($5,000/sqft)" };

  let arvLowPerSqft: number | null = null;
  if (raw.arvLowPerSqft != null) {
    const low = Number(raw.arvLowPerSqft);
    if (!Number.isFinite(low) || low <= 0) return { ok: false, error: "arv_low_per_sqft_invalid: must be a positive number when present" };
    arvLowPerSqft = Math.round(low * 100) / 100;
  }

  const compCount = Number(raw.compCount);
  if (!Number.isInteger(compCount) || compCount < 0) return { ok: false, error: "comp_count_invalid: must be a non-negative integer" };

  let fetchedAt: string | null = null;
  if (raw.fetchedAt != null && raw.fetchedAt !== "") {
    const t = Date.parse(String(raw.fetchedAt));
    if (!Number.isFinite(t)) return { ok: false, error: `fetched_at_invalid: "${raw.fetchedAt}" is not a parseable date` };
    fetchedAt = new Date(t).toISOString();
  }

  return {
    ok: true,
    data: {
      zip,
      renovatedPerSqft: Math.round(psf * 100) / 100,
      arvLowPerSqft,
      compCount,
      source: raw.source,
      market: raw.market ?? null,
      state: raw.state ?? null,
      fetchedAt,
      receiptsJson: raw.receiptsJson ?? null,
      confidence: seedConfidence(compCount),
      key: zipArvSeedKey(zip),
    },
  };
}

/** Pure: derive a ZIP-ARV seed write from an Appraiser ARV-intelligence run
 *  over a representative ZIP listing. Uses the renovated headline $/sqft and
 *  the low end of the comp band (for THIN biasing), and attaches the comps
 *  as receipts. Returns null when the run produced no usable $/sqft. */
export function seedFromArvIntelligence(
  arv: ArvIntelligenceResult,
  source: SeedSource,
  opts?: { market?: string | null; state?: string | null; fetchedAt?: string | null },
): ZipArvSeedWrite | null {
  const psf = arv.avg_per_sqft;
  if (psf == null || psf <= 0) return null;
  const lowPsf = (() => {
    const used = arv.comps_used.map((c) => c.per_sqft).filter((p) => p > 0);
    return used.length ? Math.min(...used) : null;
  })();
  const receipts = arv.comps_used.slice(0, 12).map((c) => ({
    addr: c.formatted_address ?? null,
    price: c.price,
    sqft: c.sqft,
    psf: Math.round(c.per_sqft),
    sold: c.sale_date,
    dist: c.distance,
  }));
  return {
    zip: arv.zip,
    renovatedPerSqft: psf,
    arvLowPerSqft: lowPsf,
    compCount: arv.comp_count_used,
    source,
    market: opts?.market ?? arv.market ?? null,
    state: opts?.state ?? null,
    fetchedAt: opts?.fetchedAt ?? arv.computed_at,
    receiptsJson: JSON.stringify({ method: arv.arv_method, filter_quality: arv.filter_quality, comps: receipts }),
  };
}

/** Pure: the rough ARV for a subject from a seed. THIN seeds use the LOW
 *  end of the comp band (conservative), STRONG seeds use the renovated
 *  $/sqft. Null when sqft is missing/invalid. */
export function arvForSubjectFromSeed(seed: ZipArvSeed, sqft: number | null | undefined): number | null {
  if (sqft == null || !Number.isFinite(sqft) || sqft <= 0) return null;
  const psf = seed.confidence === "THIN" && seed.arvLowPerSqft != null ? seed.arvLowPerSqft : seed.renovatedPerSqft;
  return Math.round(psf * sqft);
}

// ── Airtable I/O ────────────────────────────────────────────────────

function requirePat(): string {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");
  return AIRTABLE_PAT;
}

interface AirtableRow { id: string; fields: Record<string, unknown> }

function rowToSeed(rec: AirtableRow): ZipArvSeed | null {
  const f = rec.fields;
  const zip = typeof f["ZIP"] === "string" ? (f["ZIP"] as string) : null;
  const psf = typeof f["Renovated_PerSqft"] === "number" ? (f["Renovated_PerSqft"] as number) : null;
  const source = typeof f["Source"] === "string" ? (f["Source"] as string) : null;
  if (!zip || psf == null || psf <= 0 || !ALLOWED_SOURCES.has(source ?? "")) return null;
  const compCount = typeof f["Comp_Count"] === "number" ? (f["Comp_Count"] as number) : 0;
  const confRaw = typeof f["Confidence"] === "string" ? (f["Confidence"] as string) : null;
  return {
    zip,
    renovatedPerSqft: psf,
    arvLowPerSqft: typeof f["Arv_Low_PerSqft"] === "number" ? (f["Arv_Low_PerSqft"] as number) : null,
    compCount,
    confidence: confRaw === "STRONG" || confRaw === "THIN" ? confRaw : seedConfidence(compCount),
    source: source as SeedSource,
    market: typeof f["Market"] === "string" ? (f["Market"] as string) : null,
    state: typeof f["State"] === "string" ? (f["State"] as string) : null,
    fetchedAt: typeof f["Fetched_At"] === "string" ? (f["Fetched_At"] as string) : null,
    receiptsJson: typeof f["Comp_Receipts_JSON"] === "string" ? (f["Comp_Receipts_JSON"] as string) : null,
    recordId: rec.id,
  };
}

async function findRowByKey(key: string): Promise<AirtableRow | null> {
  const pat = requirePat();
  const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${ZIP_ARV_SEED_TABLE}`);
  url.searchParams.set("filterByFormula", `{Key}=${JSON.stringify(key)}`);
  url.searchParams.set("maxRecords", "1");
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${pat}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`ZIP_ARV_Seed list ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: AirtableRow[] };
  return body.records?.[0] ?? null;
}

/** Read the seed for a ZIP. Null when none on record. */
export async function getZipArvSeed(zip: string | null | undefined): Promise<ZipArvSeed | null> {
  const z = String(zip ?? "").trim();
  if (!/^\d{5}$/.test(z)) return null;
  const row = await findRowByKey(zipArvSeedKey(z));
  return row ? rowToSeed(row) : null;
}

/** The set of ZIPs that already carry a positive ARV seed — lets the
 *  crawler skip a paid comp pull for a ZIP it has already seeded this cycle. */
export async function listArvSeededZips(): Promise<Set<string>> {
  const pat = requirePat();
  const zips = new Set<string>();
  let offset: string | undefined;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${ZIP_ARV_SEED_TABLE}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${pat}` }, cache: "no-store" });
    if (!res.ok) throw new Error(`ZIP_ARV_Seed list ${res.status}: ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as { records?: AirtableRow[]; offset?: string };
    for (const rec of body.records ?? []) {
      const zip = typeof rec.fields["ZIP"] === "string" ? (rec.fields["ZIP"] as string).trim() : "";
      const psf = typeof rec.fields["Renovated_PerSqft"] === "number" ? (rec.fields["Renovated_PerSqft"] as number) : 0;
      if (/^\d{5}$/.test(zip) && psf > 0) zips.add(zip);
    }
    offset = body.offset;
  } while (offset);
  return zips;
}

/** Upsert a (zip) ARV seed. Refuses un-sourced / non-positive writes. */
export async function upsertZipArvSeed(raw: ZipArvSeedWrite): Promise<{ recordId: string; created: boolean }> {
  const v = validateSeedWrite(raw);
  if (!v.ok) throw new Error(`zip_arv_seed_write_refused: ${v.error}`);
  const pat = requirePat();
  const fields: Record<string, unknown> = {
    Key: v.data.key,
    ZIP: v.data.zip,
    Renovated_PerSqft: v.data.renovatedPerSqft,
    Comp_Count: v.data.compCount,
    Confidence: v.data.confidence,
    Source: v.data.source,
  };
  if (v.data.arvLowPerSqft != null) fields["Arv_Low_PerSqft"] = v.data.arvLowPerSqft;
  if (v.data.market != null) fields["Market"] = v.data.market;
  if (v.data.state != null) fields["State"] = v.data.state;
  if (v.data.fetchedAt != null) fields["Fetched_At"] = v.data.fetchedAt;
  if (v.data.receiptsJson != null) fields["Comp_Receipts_JSON"] = v.data.receiptsJson;

  const existing = await findRowByKey(v.data.key);
  if (existing) {
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${ZIP_ARV_SEED_TABLE}/${existing.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields, typecast: true }),
    });
    if (!res.ok) throw new Error(`ZIP_ARV_Seed patch ${res.status}: ${await res.text().catch(() => "")}`);
    return { recordId: existing.id, created: false };
  }
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${ZIP_ARV_SEED_TABLE}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!res.ok) throw new Error(`ZIP_ARV_Seed create ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: Array<{ id: string }> };
  const id = body.records?.[0]?.id;
  if (!id) throw new Error("ZIP_ARV_Seed create returned no record id");
  return { recordId: id, created: true };
}
