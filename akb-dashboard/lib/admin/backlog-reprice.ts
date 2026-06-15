// Review-backlog re-verify + re-price scoping (Maverick 2026-06-15).
//
// Intake skips existing records as duplicates, so the records already in the
// table never get an opener computed — they carry addresses + phones but a
// blank Rough_Opener_Amount and can't send. This pass operates IN PLACE on
// existing record IDs: liveness re-verify first, then price the live ones off
// the seed table. This module is the PURE scope predicate (tested); the route
// composes the I/O (verify → price → update).
//
// SCOPE is deliberately tight to control cost + quality:
//   - Outreach_Status ∈ {Review, Manual Review}
//   - State = MI (Detroit metro only — skip the stale TX/Memphis backlog)
//   - created on/after the fresh-cohort cutoff (default 2026-06-09)
//   - NOT already priced (blank Rough_Opener_Amount) — idempotent cursor, so
//     repeated runs never re-spend on a record already done.

import type { Listing } from "@/lib/types";

export const BACKLOG_STATUSES: ReadonlySet<string> = new Set(["Review", "Manual Review"]);
export const BACKLOG_DEFAULT_SINCE = "2026-06-09";
export const BACKLOG_DEFAULT_STATE = "MI";

export interface BacklogScopeOpts {
  /** Records created at/after this epoch-ms are in scope. */
  sinceMs: number;
  /** Target state (upper-case), e.g. "MI". */
  state: string;
  statuses?: ReadonlySet<string>;
  /** Optional ZIP narrowing; empty/absent = no ZIP filter. */
  zips?: ReadonlySet<string>;
}

/** Pure: is this existing record in scope for the re-price pass? */
export function isReviewBacklogInScope(l: Listing, opts: BacklogScopeOpts): boolean {
  const statuses = opts.statuses ?? BACKLOG_STATUSES;
  if (!statuses.has((l.outreachStatus ?? "").trim())) return false;
  if ((l.state ?? "").trim().toUpperCase() !== opts.state.trim().toUpperCase()) return false;
  if (opts.zips && opts.zips.size > 0 && !opts.zips.has((l.zip ?? "").trim())) return false;
  const created = l.createdTime ? Date.parse(l.createdTime) : NaN;
  if (!Number.isFinite(created) || created < opts.sinceMs) return false;
  // Already-priced records drop out of scope — once an opener is written the
  // record is done, so re-running the pass never re-verifies or re-spends on it.
  if (typeof l.roughOpenerAmount === "number" && l.roughOpenerAmount > 0) return false;
  return true;
}
