// Pure aggregators over audit-log entries: per-source daily spend
// counts + per-deal runaway flags. Consumed by the paid_api_spend_24h
// Pulse detector and any future spend tile.
//
// "Spend" here is call-count, not dollars. RentCast and ATTOM bill on
// metered call volume; the audit log carries one entry per call (via
// lib/spend/audit-paid-call.ts), so count IS the meter to the
// granularity Hobby-plan operator economics care about right now.
// Dollar-isation is deferred until we have a per-endpoint price table
// worth maintaining.

import type { AuditEntry } from "@/lib/audit-log";
import type { PaidApiSource } from "./audit-paid-call";

const HOURS_24_MS = 24 * 3_600_000;
const PAID_SOURCES: PaidApiSource[] = ["rentcast", "attom"];

/** HTTP codes on a `paid_api_call` row that the vendor did NOT bill for.
 *
 *  Two distinct kinds, both genuinely free:
 *
 *  - 598 / 599 are SYNTHETIC — lib/rentcast.ts stamps them when the spend
 *    ceiling refused the call (598) or the failure-loop breaker was tripped
 *    (599). No HTTP request ever left the process. Counting these is not
 *    merely inaccurate, it is self-sustaining: hitting a ceiling writes rows
 *    that keep the meter above that ceiling, so a lane that trips once stays
 *    locked out long after real spend has decayed.
 *  - 401 / 403 are vendor auth rejections, unbilled at the vendor — the same
 *    fact lib/rentcast/failure-loop-breaker.ts already relies on to justify
 *    its short 30-minute auth cooldown ("403s are unbilled at the vendor").
 *
 *  Deliberately NOT here: http -1 (the request threw before a response). The
 *  vendor bills on the request, not the response, so a thrown call may well
 *  have cost money — counting it is the conservative read. 404 is likewise
 *  absent because it is already recorded as an honest empty answer
 *  (forceSuccess) and IS billed. */
const UNBILLED_HTTP = new Set([401, 403, 598, 599]);

/** Pure: did this paid-call row cost money? Rows the vendor never billed
 *  must not consume a spend budget — during the 2026-08-01 RentCast outage
 *  every call 403'd, which is exactly when the ceilings should be OPEN so
 *  work resumes the moment the key is fixed, not clamped shut by a meter
 *  full of free failures. */
export function isBilledCall(e: AuditEntry): boolean {
  if (e.event !== "paid_api_call") return false;
  if (!PAID_SOURCES.includes(e.agent as PaidApiSource)) return false;
  const http = (e.outputSummary as Record<string, unknown> | undefined)?.http;
  if (typeof http === "number" && UNBILLED_HTTP.has(http)) return false;
  return true;
}

function isPaidCall(e: AuditEntry): boolean {
  return isBilledCall(e);
}

function within24h(e: AuditEntry, nowMs: number): boolean {
  const t = new Date(e.ts).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= nowMs - HOURS_24_MS;
}

export interface SpendCountsBySource {
  rentcast: number;
  attom: number;
  total: number;
}

/** Total paid-API calls per source in the last 24h. */
export function countCallsBySource24h(
  audit: AuditEntry[],
  now: Date,
): SpendCountsBySource {
  const nowMs = now.getTime();
  const counts: SpendCountsBySource = { rentcast: 0, attom: 0, total: 0 };
  for (const e of audit) {
    if (!isPaidCall(e)) continue;
    if (!within24h(e, nowMs)) continue;
    const src = e.agent as PaidApiSource;
    counts[src]++;
    counts.total++;
  }
  return counts;
}

export interface DealRunawayRow {
  recordId: string;
  calls: number;
  bySource: { rentcast: number; attom: number };
}

/** Paid-call counts grouped by recordId in the last 24h, sorted desc by
 *  total. Drops entries without a recordId (zip-level discovery scans —
 *  not attributable to a deal, so not a runaway signal). */
export function countCallsByDeal24h(
  audit: AuditEntry[],
  now: Date,
): DealRunawayRow[] {
  const nowMs = now.getTime();
  const byDeal = new Map<string, DealRunawayRow>();
  for (const e of audit) {
    if (!isPaidCall(e)) continue;
    if (!within24h(e, nowMs)) continue;
    if (!e.recordId) continue;
    const row =
      byDeal.get(e.recordId) ??
      ({ recordId: e.recordId, calls: 0, bySource: { rentcast: 0, attom: 0 } } satisfies DealRunawayRow);
    row.calls++;
    if (e.agent === "rentcast") row.bySource.rentcast++;
    else if (e.agent === "attom") row.bySource.attom++;
    byDeal.set(e.recordId, row);
  }
  return Array.from(byDeal.values()).sort((a, b) => b.calls - a.calls);
}

export interface RunawaySplit {
  /** Deals strictly above `threshold` calls in 24h — the alarm set. */
  runaway: DealRunawayRow[];
  /** All other deals with at least one paid call. Returned so a
   *  detector can show "23 deals at <=N, 2 deals at >N" without
   *  rerunning the aggregation. */
  rest: DealRunawayRow[];
}

/** Partition the 24h per-deal counts at `threshold`. A deal is runaway
 *  iff its call count is strictly greater than `threshold`. */
export function splitRunaway(
  rows: DealRunawayRow[],
  threshold: number,
): RunawaySplit {
  const runaway: DealRunawayRow[] = [];
  const rest: DealRunawayRow[] = [];
  for (const r of rows) {
    if (r.calls > threshold) runaway.push(r);
    else rest.push(r);
  }
  return { runaway, rest };
}
