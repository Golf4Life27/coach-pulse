// Appraiser-backfill: a GUARANTEED daily slice, not a share of a shared total.
// @agent: appraiser
//
// THE BUG THIS REPLACES (measured 2026-08-04): the sweep gated on TOTAL 24h
// paid calls across every lane — `countCallsBySource24h(...) >= 60` — and the
// system's observed baseline burn is ~79/day from the underwrite and intake
// lanes alone. So the comparison was already lost before the sweep looked at
// a single record. EVERY 30-minute slot on 8/4 returned
// `backfill_paid_calls_24h_ceiling`, examined 3, processed 0. The sweep did
// not underperform; it never executed. 270 records sat rehab-dark all day.
//
// Raising that ceiling would not have fixed it either — at 79/day of sibling
// spend, any shared-total threshold under 79 locks the sweep out permanently
// and any threshold above it stops bounding anything. The shape is wrong, not
// the number. lib/spend/paid-call-lanes.ts has the lane CONCEPT but every lane
// still compares against the same shared total, so migrating to it as-built
// reproduces the same lockout.
//
// The fix is a dedicated allowance the sweep alone spends against, so sibling
// lanes cannot crowd it to zero. Total exposure stays bounded because the
// global RentCast spend ceiling (lib/rentcast/spend-ceiling, now atomic) still
// refuses every call once the plan cap is reached — this budget decides how
// much of the plan the sweep MAY use, never how much the plan holds.
//
// Denominated in RECORDS, not calls, because that is the unit the operator is
// trying to observe ("is the backfill working") and the unit the route already
// slices by. Worst case a record costs ~4 paid calls (2 RentCast photo pulls,
// 1 rent, 1 ATTOM comps), so the default 5/day is ~20 calls/day.

/** Records the sweep may process per UTC day. Deliberately small: at the
 *  observed 79/day baseline the 1,000-call plan is already spent in ~11 days,
 *  so this slice is sized to PROVE the lane works over a few days rather than
 *  to drain the backlog. Raise once the plan is upgraded.
 *  ponytail: flat daily cap; make it adaptive only if the burn model changes. */
export const DEFAULT_BACKFILL_DAILY_RECORDS = 5;

export function backfillDailyRecordBudget(): number {
  const raw = Number(process.env.BACKFILL_DAILY_RECORDS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_BACKFILL_DAILY_RECORDS;
}

/** KV key for the sweep's own daily record counter. Separate namespace from
 *  the RentCast spend meter — this counts SWEEP WORK, not vendor calls. */
export function backfillDayKey(now: Date): string {
  return `backfill:records:d:${now.toISOString().slice(0, 10)}`;
}

/** 48h so a key outlives its day for inspection, then self-cleans. */
export const BACKFILL_DAY_TTL_S = 172_800;

export interface BackfillBudgetVerdict {
  allowed: boolean;
  spentToday: number | null;
  budget: number;
  /** How many records this run may still process (0 when blocked). */
  remaining: number;
  reason: "ok" | "daily_record_budget_reached" | "meter_unreadable_fail_open" | "budget_disabled";
}

/**
 * Pure: may the sweep process records right now, and how many?
 *
 * FAILS OPEN on an unreadable meter, matching every other brake in this
 * codebase (the per-run `limit` and the global spend ceiling remain the
 * backstops). A monitoring outage must not be the thing that dark-starts the
 * only lane that converts supply into sendable inventory.
 */
export function checkBackfillBudget(
  spentToday: number | null,
  budget: number = backfillDailyRecordBudget(),
): BackfillBudgetVerdict {
  if (budget <= 0) {
    return { allowed: false, spentToday, budget, remaining: 0, reason: "budget_disabled" };
  }
  if (spentToday == null) {
    return { allowed: true, spentToday: null, budget, remaining: budget, reason: "meter_unreadable_fail_open" };
  }
  const remaining = Math.max(0, budget - spentToday);
  if (remaining <= 0) {
    return { allowed: false, spentToday, budget, remaining: 0, reason: "daily_record_budget_reached" };
  }
  return { allowed: true, spentToday, budget, remaining, reason: "ok" };
}
