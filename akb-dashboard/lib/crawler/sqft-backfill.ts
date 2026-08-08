// SQFT BACKFILL — the missing input that HOLDs a record with no way out.
// @agent: appraiser/scout
//
// WHY (measured 2026-08-06): 324 of 443 eligible records hold with
// `opener_hold_no_value_basis`. That reason resolves to one sentence in
// lib/rough-opener-ceiling.ts: "no ZIP $/sqft seed × sqft". The seed half is
// largely SOLVED — 121 ZIP seeds exist, 97 of them STRONG. The other half is
// not: 124 active records carry NO Building_SqFt, and without it there is no
// ARV, so the opener can never derive and the record holds forever.
//
// A hold whose input can be fetched is not a hold, it is a gap. This closes it.
//
// COST SHAPE: one /listings/sale call per ZIP-with-gaps, not per record —
// the same hybrid shape that fixed enrichment (PR #191). The call already
// returns ~100 listings WITH squareFootage attached, so 20 records in a ZIP
// cost ONE call. Routed through fetchListingsByZip, so the spend ceiling,
// loop breaker and paid_api_call audit all apply unchanged.
//
// HONEST SCOPE: sqft alone does not unlock every record it fills. A record in
// a market whose openerArvPctMax resolves null (TX non-disclosure; a market
// configured but not arv_source_verified) still holds after this runs — the
// buy-box is missing, not the sqft. Of the 124, roughly 27 are in markets that
// price today. This fills all of them anyway: the other ~97 become instantly
// priceable the moment their market config is fixed, and every FUTURE record
// lands complete.

import { fetchListingsByZip } from "@/lib/crawler/sources/rentcast";
import { findMatchingListing } from "@/lib/crawler/sweep-enrich";

/** A record missing sqft, as selected from Airtable. */
export interface SqftGapRecord {
  recordId: string;
  address: string | null;
  zip: string | null;
}

export type SqftSkipReason =
  | "no_zip"
  | "no_address"
  | "zip_fetch_failed"
  | "no_feed_match"
  | "feed_has_no_sqft"
  | "sqft_out_of_band";

export interface SqftFillOutcome {
  recordId: string;
  address: string | null;
  zip: string | null;
  sqft: number | null;
  skipped: SqftSkipReason | null;
}

// A house is not 80 sqft and it is not 20,000. A feed value outside this band
// is a data error, and writing it would be worse than the null we started
// with — a bad sqft produces a confident WRONG ARV, which is how a real offer
// lands on the wrong number. Out-of-band values are skipped and named.
export const SQFT_MIN = 300;
export const SQFT_MAX = 12_000;

/** Pure: is this a sqft value worth writing to a record? */
export function isPlausibleSqft(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= SQFT_MIN && v <= SQFT_MAX;
}

/** Pure: group gap records by ZIP so each ZIP costs exactly one paid call.
 *  Records with no ZIP cannot be grouped and are returned separately — they
 *  are a skip, never a guess. */
export function groupByZip(records: readonly SqftGapRecord[]): {
  byZip: Map<string, SqftGapRecord[]>;
  noZip: SqftGapRecord[];
} {
  const byZip = new Map<string, SqftGapRecord[]>();
  const noZip: SqftGapRecord[] = [];
  for (const r of records) {
    const zip = (r.zip ?? "").trim();
    if (!/^\d{5}$/.test(zip)) {
      noZip.push(r);
      continue;
    }
    const list = byZip.get(zip) ?? [];
    list.push(r);
    byZip.set(zip, list);
  }
  return { byZip, noZip };
}

/** Pure: roll outcomes into a run summary that names WHY a gap stayed open. */
export function summarizeSqftBackfill(outcomes: readonly SqftFillOutcome[]): {
  attempted: number;
  filled: number;
  by_skip: Record<string, number>;
} {
  const by_skip: Record<string, number> = {};
  let filled = 0;
  for (const o of outcomes) {
    if (o.sqft != null) filled++;
    else if (o.skipped) by_skip[o.skipped] = (by_skip[o.skipped] ?? 0) + 1;
  }
  return { attempted: outcomes.length, filled, by_skip };
}

export interface RunSqftBackfillDeps {
  fetchZip?: typeof fetchListingsByZip;
  /** Wall-clock guard: return true to stop starting new ZIPs. */
  outOfTime?: () => boolean;
}

/** Resolve sqft for each gap record from its ZIP's feed. Does NOT write —
 *  the caller batches the Airtable PATCH, so this stays testable without I/O
 *  mocks for two different services. */
export async function resolveSqft(
  records: readonly SqftGapRecord[],
  deps: RunSqftBackfillDeps = {},
): Promise<SqftFillOutcome[]> {
  const fetchZip = deps.fetchZip ?? fetchListingsByZip;
  const outOfTime = deps.outOfTime ?? (() => false);
  const { byZip, noZip } = groupByZip(records);

  const outcomes: SqftFillOutcome[] = noZip.map((r) => ({
    recordId: r.recordId,
    address: r.address,
    zip: r.zip,
    sqft: null,
    skipped: "no_zip" as const,
  }));

  for (const [zip, group] of byZip) {
    if (outOfTime()) break;

    let candidates: Awaited<ReturnType<typeof fetchListingsByZip>>["candidates"] = [];
    let fetchFailed = false;
    try {
      const res = await fetchZip(zip);
      candidates = res.candidates ?? [];
    } catch {
      // A vendor blip on one ZIP is a skip for that ZIP, never a failed run.
      fetchFailed = true;
    }

    for (const r of group) {
      if (fetchFailed) {
        outcomes.push({ ...r, sqft: null, skipped: "zip_fetch_failed" });
        continue;
      }
      if (!r.address) {
        outcomes.push({ ...r, sqft: null, skipped: "no_address" });
        continue;
      }
      const match = findMatchingListing(r.address, candidates);
      if (!match) {
        outcomes.push({ ...r, sqft: null, skipped: "no_feed_match" });
        continue;
      }
      const raw = (match as { squareFootage?: unknown }).squareFootage;
      if (raw == null) {
        outcomes.push({ ...r, sqft: null, skipped: "feed_has_no_sqft" });
        continue;
      }
      if (!isPlausibleSqft(raw)) {
        outcomes.push({ ...r, sqft: null, skipped: "sqft_out_of_band" });
        continue;
      }
      outcomes.push({ ...r, sqft: raw, skipped: null });
    }
  }

  return outcomes;
}
