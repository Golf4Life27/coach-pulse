// ZIP_Daily_Stats data layer (Workstream D1 — 24.5).
// @agent: scout / sentinel
//
// One upsertable row per ZIP per intake run. The listings-intake cron
// APPENDS a row each live registry-driven run (Sample_Key = {zip}_{day},
// so a same-day re-run overwrites rather than duplicates). The
// zip-saturation-check cron SUMS the trailing-N-day rows per ZIP to
// produce the *true* rolling Accept_Rate_30d / Avg_DOM / Avg_List_Price /
// Records_Ingested_30d it writes back to ZIP_Registry — replacing the
// latest-run snapshot 24.2 wrote as a placeholder.
//
// Rejected is tracked separately from (Considered − Accepted) so the
// saturation cron + Pulse can tell a market that's genuinely saturating
// (rejections steady, accepts fall) from one that only looks saturated
// because the classifier got stricter (rejections climb).

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const ZIP_DAILY_STATS_TABLE = "tblGyZZl1ebGZbDwA";

// Field IDs (written + read by ID, mirroring lib/zip-registry.ts).
export const ZDS = {
  sampleKey: "fldIuXfrTg2RuEt7d",
  zip: "fldAJaa3jvXSScJYU",
  date: "fldP9DawXiBVxdnAM",
  considered: "fldQGpGL708LVVny5",
  accepted: "fldp349uIs8RAF8S8",
  rejected: "fldHgTwpf4xetSOID",
  ingested: "fld29VIUm3s45hbG7",
  domSum: "fldekaoiPLE6AP867",
  domCount: "fldU3w7vPSh3yX8XJ",
  priceSum: "fldvJequsBaSQtPcn",
  priceCount: "fldLH0rwwQaRE1fV3",
  runAt: "fldzXwHylLRPXJnyE",
} as const;

// ───────────────────── pure: keys + shapes ─────────────────────

/** UTC calendar day, YYYY-MM-DD. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Idempotent per-ZIP-per-day upsert key. */
export function dailySampleKey(zip: string, d: Date): string {
  return `${zip}_${isoDay(d)}`;
}

export interface DailyStatInput {
  zip: string;
  date: Date; // the run's UTC day
  considered: number;
  accepted: number;
  rejected: number;
  ingested: number;
  domSum: number;
  domCount: number;
  priceSum: number;
  priceCount: number;
  runAt: string; // ISO 8601
}

export interface DailyStatRow {
  recordId: string;
  sampleKey: string;
  zip: string;
  date: string; // YYYY-MM-DD
  considered: number;
  accepted: number;
  rejected: number;
  ingested: number;
  domSum: number;
  domCount: number;
  priceSum: number;
  priceCount: number;
}

export interface RollingAggregate {
  considered: number;
  accepted: number;
  rejected: number;
  ingested: number;
  domSum: number;
  domCount: number;
  priceSum: number;
  priceCount: number;
  sampleDays: number; // distinct contributing calendar days
}

export interface RollingSummary {
  acceptRate: number | null; // accepted / considered (fraction), null when no candidates
  avgDom: number | null;
  avgListPrice: number | null;
  recordsIngested: number;
  considered: number;
  sampleDays: number;
}

/** Pure: map an intake-run input to an Airtable field-id payload. The
 *  Date field takes the YYYY-MM-DD calendar day; Sample_Key is the merge
 *  key so a same-day re-run upserts in place. */
export function buildUpsertFields(input: DailyStatInput): Record<string, unknown> {
  return {
    [ZDS.sampleKey]: dailySampleKey(input.zip, input.date),
    [ZDS.zip]: input.zip,
    [ZDS.date]: isoDay(input.date),
    [ZDS.considered]: input.considered,
    [ZDS.accepted]: input.accepted,
    [ZDS.rejected]: input.rejected,
    [ZDS.ingested]: input.ingested,
    [ZDS.domSum]: input.domSum,
    [ZDS.domCount]: input.domCount,
    [ZDS.priceSum]: input.priceSum,
    [ZDS.priceCount]: input.priceCount,
    [ZDS.runAt]: input.runAt,
  };
}

const ZERO_AGG: RollingAggregate = {
  considered: 0,
  accepted: 0,
  rejected: 0,
  ingested: 0,
  domSum: 0,
  domCount: 0,
  priceSum: 0,
  priceCount: 0,
  sampleDays: 0,
};

/** Pure: sum a set of daily rows into one aggregate. sampleDays counts
 *  distinct calendar days (not rows) so a same-day re-run that wasn't
 *  upserted doesn't inflate the window. */
export function aggregateRows(rows: DailyStatRow[]): RollingAggregate {
  const days = new Set<string>();
  const agg = { ...ZERO_AGG };
  for (const r of rows) {
    agg.considered += r.considered;
    agg.accepted += r.accepted;
    agg.rejected += r.rejected;
    agg.ingested += r.ingested;
    agg.domSum += r.domSum;
    agg.domCount += r.domCount;
    agg.priceSum += r.priceSum;
    agg.priceCount += r.priceCount;
    if (r.date) days.add(r.date);
  }
  agg.sampleDays = days.size;
  return agg;
}

/** Pure: derive the registry-facing rolling figures from an aggregate. */
export function summarize(agg: RollingAggregate): RollingSummary {
  return {
    acceptRate: agg.considered > 0 ? agg.accepted / agg.considered : null,
    avgDom: agg.domCount > 0 ? Math.round(agg.domSum / agg.domCount) : null,
    avgListPrice: agg.priceCount > 0 ? Math.round(agg.priceSum / agg.priceCount) : null,
    recordsIngested: agg.ingested,
    considered: agg.considered,
    sampleDays: agg.sampleDays,
  };
}

// ───────────────────── I/O ─────────────────────

function requirePat(): string {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");
  return AIRTABLE_PAT;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function mapRow(rec: { id: string; fields: Record<string, unknown> }): DailyStatRow {
  const f = rec.fields;
  return {
    recordId: rec.id,
    sampleKey: typeof f[ZDS.sampleKey] === "string" ? (f[ZDS.sampleKey] as string) : "",
    zip: typeof f[ZDS.zip] === "string" ? (f[ZDS.zip] as string) : "",
    date: typeof f[ZDS.date] === "string" ? (f[ZDS.date] as string) : "",
    considered: num(f[ZDS.considered]),
    accepted: num(f[ZDS.accepted]),
    rejected: num(f[ZDS.rejected]),
    ingested: num(f[ZDS.ingested]),
    domSum: num(f[ZDS.domSum]),
    domCount: num(f[ZDS.domCount]),
    priceSum: num(f[ZDS.priceSum]),
    priceCount: num(f[ZDS.priceCount]),
  };
}

async function fetchAllRows(): Promise<DailyStatRow[]> {
  const pat = requirePat();
  const rows: DailyStatRow[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams();
    Object.values(ZDS).forEach((id) => params.append("fields[]", id));
    params.set("returnFieldsByFieldId", "true");
    params.set("pageSize", "100");
    if (offset) params.set("offset", offset);
    const url = `https://api.airtable.com/v0/${BASE_ID}/${ZIP_DAILY_STATS_TABLE}?${params.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${pat}` }, cache: "no-store" });
    if (!res.ok) {
      throw new Error(`ZIP_Daily_Stats fetch error ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as {
      records: Array<{ id: string; fields: Record<string, unknown> }>;
      offset?: string;
    };
    for (const rec of data.records) rows.push(mapRow(rec));
    offset = data.offset;
  } while (offset);
  return rows;
}

/** Trailing-window aggregates, keyed by ZIP. Includes rows whose Date is
 *  >= (asOf − windowDays), inclusive — so windowDays=30 spans today plus
 *  the prior 29 calendar days. Volume is bounded (active-ZIP count ×
 *  windowDays), so a full read + in-memory group avoids brittle Airtable
 *  date-formula filtering. */
export async function getRollingByZip(opts: {
  windowDays: number;
  asOf: Date;
}): Promise<Map<string, RollingAggregate>> {
  const cutoff = isoDay(new Date(opts.asOf.getTime() - opts.windowDays * 86_400_000));
  const all = await fetchAllRows();
  const byZip = new Map<string, DailyStatRow[]>();
  for (const r of all) {
    if (!r.zip || !r.date || r.date < cutoff) continue;
    const bucket = byZip.get(r.zip);
    if (bucket) bucket.push(r);
    else byZip.set(r.zip, [r]);
  }
  const out = new Map<string, RollingAggregate>();
  for (const [zip, rs] of byZip) out.set(zip, aggregateRows(rs));
  return out;
}

/** Upsert daily-stat rows, merging on Sample_Key (idempotent per ZIP per
 *  day). Batched at Airtable's 10-record write ceiling. Returns counts +
 *  per-chunk errors (never throws — a stats-write failure must not abort
 *  the intake run that produced the listings). */
export async function appendDailyStats(
  inputs: DailyStatInput[],
): Promise<{ upserted: number; errors: string[] }> {
  if (inputs.length === 0) return { upserted: 0, errors: [] };
  const pat = requirePat();
  const url = `https://api.airtable.com/v0/${BASE_ID}/${ZIP_DAILY_STATS_TABLE}`;
  let upserted = 0;
  const errors: string[] = [];
  for (let i = 0; i < inputs.length; i += 10) {
    const chunk = inputs.slice(i, i + 10);
    const body = {
      performUpsert: { fieldsToMergeOn: [ZDS.sampleKey] },
      records: chunk.map((c) => ({ fields: buildUpsertFields(c) })),
      typecast: true,
    };
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        errors.push(`chunk ${i / 10}: ${res.status} ${await res.text().catch(() => "")}`);
        continue;
      }
      const data = (await res.json()) as { records?: Array<{ id: string }> };
      upserted += data.records?.length ?? chunk.length;
    } catch (err) {
      errors.push(`chunk ${i / 10}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { upserted, errors };
}
