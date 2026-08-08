// SQFT BACKFILL cron — close the gap that HOLDs a record with no way out.
// @agent: appraiser
//
// 124 active records carry no Building_SqFt (measured 2026-08-06). Without it
// there is no ARV (seed $/sqft × sqft), so the opener holds as
// `opener_hold_no_value_basis` — 324 of 443 eligible records, the single
// largest hold in the pool. Seeds are largely solved (121 ZIPs, 97 STRONG);
// sqft is the half nobody was filling.
//
// One /listings/sale call per ZIP-with-gaps (not per record) — the same hybrid
// shape that fixed enrichment. Routed through fetchListingsByZip so the spend
// ceiling, loop breaker and paid_api_call audit apply unchanged.
//
// ?dry_run=1  resolve and report, write nothing (default 0 — this is a cron)
// ?limit=N    max records to consider (default 150)

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { patchListingsBatch } from "@/lib/airtable";
import {
  resolveSqft,
  summarizeSqftBackfill,
  type SqftGapRecord,
} from "@/lib/crawler/sqft-backfill";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const F_SQFT = "fld5bKGJLlN7GmiE9"; // Building_SqFt
const F_ZIP = "fld9PTaKkgBNtvWbB"; // Zip
const F_ADDRESS = "fldwvp72hKTfiHHjj"; // Address

// Leave room to WRITE after resolving — a run that spends its whole budget
// fetching and dies before the PATCH has burned paid calls for nothing.
const RESOLVE_BUDGET_MS = 200_000;
const AIRTABLE_BATCH = 10;

/** Active records with NO Building_SqFt — the gap set. */
async function fetchGaps(limit: number): Promise<SqftGapRecord[]> {
  if (!AIRTABLE_PAT) return [];
  const formula = `AND({Live_Status}='Active', {Building_SqFt}='')`;
  const out: SqftGapRecord[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    [F_SQFT, F_ZIP, F_ADDRESS].forEach((f) => params.append("fields[]", f));
    params.set("returnFieldsByFieldId", "true");
    params.set("filterByFormula", formula);
    params.set("pageSize", "100");
    if (offset) params.set("offset", offset);

    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}?${params.toString()}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }, cache: "no-store" },
    );
    if (!res.ok) break;
    const body = (await res.json()) as {
      records?: Array<{ id: string; fields?: Record<string, unknown> }>;
      offset?: string;
    };
    for (const r of body.records ?? []) {
      if (out.length >= limit) break;
      const f = r.fields ?? {};
      out.push({
        recordId: r.id,
        address: typeof f[F_ADDRESS] === "string" ? (f[F_ADDRESS] as string) : null,
        zip: typeof f[F_ZIP] === "string" ? (f[F_ZIP] as string) : null,
      });
    }
    offset = out.length >= limit ? undefined : body.offset;
  } while (offset);

  return out;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 300) : 150;

  const gaps = await fetchGaps(limit);
  const outcomes = await resolveSqft(gaps, {
    outOfTime: () => Date.now() - t0 > RESOLVE_BUDGET_MS,
  });

  const fills = outcomes.filter((o) => o.sqft != null);
  let written = 0;
  const writeErrors: string[] = [];

  if (!dryRun && fills.length > 0) {
    for (let i = 0; i < fills.length; i += AIRTABLE_BATCH) {
      const chunk = fills.slice(i, i + AIRTABLE_BATCH);
      try {
        const res = await patchListingsBatch(
          chunk.map((f) => ({ recordId: f.recordId, fields: { Building_SqFt: f.sqft } })),
        );
        for (const r of res) {
          if (r.error) writeErrors.push(`${r.recordId}: ${r.error}`);
          else written++;
        }
      } catch (err) {
        // Airtable batches are all-or-nothing; one bad chunk must not lose
        // the rest of the run.
        writeErrors.push(
          `batch@${i}: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
        );
      }
    }
  }

  const summary = {
    ...summarizeSqftBackfill(outcomes),
    gaps_found: gaps.length,
    resolved: fills.length,
    written,
    write_errors: writeErrors.slice(0, 10),
    dry_run: dryRun,
    ms: Date.now() - t0,
  };

  await audit({
    agent: "appraiser",
    event: "sqft_backfill",
    status: writeErrors.length > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { limit, dry_run: dryRun },
    outputSummary: summary,
    decision: `${written} filled of ${gaps.length} gaps`,
  });

  return NextResponse.json(summary);
}
