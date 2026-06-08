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

function isPaidCall(e: AuditEntry): boolean {
  return e.event === "paid_api_call" && PAID_SOURCES.includes(e.agent as PaidApiSource);
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
