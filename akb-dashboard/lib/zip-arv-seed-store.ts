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

// STRONG/THIN price off the seed; DONT_PRICE is a SENTINEL (Maverick
// 2026-06-15 seed-quality gate): the ZIP was evaluated but its comps were too
// few or too dispersed to trust, so it is cached as "do not price off this"
// and the pricer falls to the flat 65%-of-list rail — NOT back to the
// contaminated stored ARV. Caching it (rather than leaving the ZIP unseeded)
// also stops the auto-seed loop re-pulling a known-noisy ZIP every run.
export type SeedConfidence = "STRONG" | "THIN" | "DONT_PRICE";
export type SeedSource = "rentcast_avm" | "attom_salescomparables";
const ALLOWED_SOURCES: ReadonlySet<string> = new Set(["rentcast_avm", "attom_salescomparables"]);

export interface ZipArvSeed {
  zip: string;
  renovatedPerSqft: number;
  arvLowPerSqft: number | null;
  compCount: number;
  confidence: SeedConfidence;
  /** True when confidence === "DONT_PRICE" — the pricer must ignore this
   *  seed's $/sqft and fall to the 65%-of-list rail (never to stored ARV). */
  dontPrice: boolean;
  source: SeedSource;
  market: string | null;
  state: string | null;
  fetchedAt: string | null;
  receiptsJson: string | null;
  recordId: string;
}

export interface ZipArvSeedWrite {
  zip: string;
  /** Required for a priceable seed; 0/omitted only for a DONT_PRICE sentinel. */
  renovatedPerSqft?: number;
  arvLowPerSqft?: number | null;
  compCount: number;
  source: SeedSource;
  market?: string | null;
  state?: string | null;
  fetchedAt?: string | null;
  receiptsJson?: string | null;
  /** Mark this ZIP do-not-price (seed-quality gate failed). */
  dontPrice?: boolean;
}

export type SeedWriteValidation =
  | { ok: true; data: ZipArvSeedWrite & { renovatedPerSqft: number; confidence: SeedConfidence; key: string } }
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

  // DONT_PRICE sentinel: the seed-quality gate failed, so no $/sqft is trusted.
  // Store 0 and skip the positive-$/sqft requirement; the pricer reads the
  // DONT_PRICE confidence and falls to the 65%-of-list rail.
  const dontPrice = raw.dontPrice === true;
  let psf = 0;
  if (!dontPrice) {
    psf = Number(raw.renovatedPerSqft);
    if (!Number.isFinite(psf) || psf <= 0) return { ok: false, error: "renovated_per_sqft_invalid: a positive $/sqft is required" };
    if (psf > 5_000) return { ok: false, error: "renovated_per_sqft_out_of_range: exceeds sanity bound ($5,000/sqft)" };
  }

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
      dontPrice,
      confidence: dontPrice ? "DONT_PRICE" : seedConfidence(compCount),
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
  // DONT_PRICE sentinel → no ARV (pricer falls to 65%-of-list, never stored).
  if (seed.dontPrice || seed.confidence === "DONT_PRICE") return null;
  if (sqft == null || !Number.isFinite(sqft) || sqft <= 0) return null;
  const psf = seed.confidence === "THIN" && seed.arvLowPerSqft != null ? seed.arvLowPerSqft : seed.renovatedPerSqft;
  return Math.round(psf * sqft);
}

// ── SIZE-EXTRAPOLATION GUARD (bug 2026-07-23, 927 Avon St) ──────────────
// A seed's renovated $/sqft is derived from its comp cluster's sizes. Applying
// it LINEARLY to a subject far outside that size band overstates ARV badly:
// $/sqft compresses as houses get bigger, so a psf from ~1,000 sqft comps
// texted a $121,250 opener on a 2,605 sqft house worth ~$180k (44310 comps ran
// 978–1,236 sqft — the subject was 2.1× the largest). psf × sqft has no size
// guard, and no downstream rail caught it (ARV > list, so the ARV-sanity gate
// never fired). This guard HOLDS such records for operator review instead of
// autonomously sending an extrapolated number — doctrine-consistent: no trusted
// basis → HOLD, never a fabricated send.

/** Env-tunable size-band tolerance. A subject beyond max_comp × T (or below
 *  min_comp ÷ T) is a size extrapolation the psf-derived ARV cannot support. */
export const SEED_SIZE_BAND_TOLERANCE = (() => {
  const raw = Number(process.env.SEED_SIZE_BAND_TOLERANCE);
  return Number.isFinite(raw) && raw >= 1 ? raw : 1.5;
})();

export interface SeedCompSqftBand {
  min: number;
  max: number;
  count: number;
}

/** Pure: the comp square-footage band from a seed's stored receipts. Null when
 *  the receipts are absent/unparseable or carry no positive comp sqft (older
 *  seeds without receipts simply aren't guarded — we never block on absence). */
export function seedCompSqftBand(seed: Pick<ZipArvSeed, "receiptsJson">): SeedCompSqftBand | null {
  if (!seed.receiptsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(seed.receiptsJson);
  } catch {
    return null;
  }
  const comps = (parsed as { comps?: Array<{ sqft?: unknown }> } | null)?.comps;
  if (!Array.isArray(comps)) return null;
  const sqfts = comps.map((c) => Number(c?.sqft)).filter((s) => Number.isFinite(s) && s > 0);
  if (sqfts.length === 0) return null;
  return { min: Math.min(...sqfts), max: Math.max(...sqfts), count: sqfts.length };
}

export interface SizeBandVerdict {
  /** True → the subject is so far outside the comp size band that the
   *  psf-derived ARV is a size extrapolation and must not be trusted. */
  outside: boolean;
  reason: string | null;
  band: SeedCompSqftBand | null;
}

/** Pure: is the subject square footage so far outside the seed's comp size band
 *  that a psf-derived ARV can't be trusted? When there is no comp sqft to judge
 *  against (older seed / no receipts), we do NOT block (outside=false). */
export function subjectOutsideCompSizeBand(
  seed: Pick<ZipArvSeed, "receiptsJson">,
  sqft: number | null | undefined,
  tolerance: number = SEED_SIZE_BAND_TOLERANCE,
): SizeBandVerdict {
  const band = seedCompSqftBand(seed);
  if (band == null || sqft == null || !Number.isFinite(sqft) || sqft <= 0) {
    return { outside: false, reason: null, band };
  }
  if (sqft > band.max * tolerance) {
    return {
      outside: true,
      reason: `subject ${Math.round(sqft)} sqft > ${tolerance}× the largest comp (${band.max} sqft) — psf-derived ARV extrapolates above the comp size band`,
      band,
    };
  }
  if (sqft < band.min / tolerance) {
    return {
      outside: true,
      reason: `subject ${Math.round(sqft)} sqft < the smallest comp (${band.min} sqft) ÷ ${tolerance} — psf-derived ARV extrapolates below the comp size band`,
      band,
    };
  }
  return { outside: false, reason: null, band };
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
  const confRaw = typeof f["Confidence"] === "string" ? (f["Confidence"] as string) : null;
  const isDontPrice = confRaw === "DONT_PRICE";
  // A DONT_PRICE sentinel row is valid with psf=0; a priceable row needs psf>0.
  if (!zip || !ALLOWED_SOURCES.has(source ?? "")) return null;
  if (!isDontPrice && (psf == null || psf <= 0)) return null;
  const compCount = typeof f["Comp_Count"] === "number" ? (f["Comp_Count"] as number) : 0;
  return {
    zip,
    renovatedPerSqft: psf ?? 0,
    arvLowPerSqft: typeof f["Arv_Low_PerSqft"] === "number" ? (f["Arv_Low_PerSqft"] as number) : null,
    compCount,
    confidence: confRaw === "STRONG" || confRaw === "THIN" || confRaw === "DONT_PRICE" ? confRaw : seedConfidence(compCount),
    dontPrice: isDontPrice,
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
      const dontPrice = rec.fields["Confidence"] === "DONT_PRICE";
      // A DONT_PRICE sentinel counts as seeded too — the ZIP was evaluated and
      // must not be re-pulled every run (that was the budget-churn the gate
      // is meant to prevent).
      if (/^\d{5}$/.test(zip) && (psf > 0 || dontPrice)) zips.add(zip);
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
