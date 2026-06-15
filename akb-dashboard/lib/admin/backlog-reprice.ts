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

// ── ROUTING (Maverick 2026-06-15) — after pricing a LIVE record, decide
// whether it stays in Review (the sendable set) or routes to Manual Review. ──

/** Hot-seed caution: an opener ABOVE this fraction of list routes to Manual
 *  Review (existing >75%-of-list doctrine). The capped_to_list basis (0.90 of
 *  list) always trips it. Env-tunable. */
export const HOT_SEED_PCT_OF_LIST = (() => {
  const raw = Number(process.env.BACKLOG_HOT_SEED_PCT);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
})();

/** Detroit buy-box list-price ceiling: any record listed ABOVE this routes to
 *  Manual Review regardless of pricing basis (luxury / 65%-fallback mis-shape
 *  catch). An arv_buybox record above the ceiling goes to Manual Review too —
 *  a human look, not an auto-reject. Env-tunable. */
export const DETROIT_LIST_CEILING_USD = (() => {
  const raw = Number(process.env.BACKLOG_LIST_CEILING_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 250_000;
})();

export type BacklogRoute = "review" | "manual_review";
export interface BacklogRouteVerdict {
  route: BacklogRoute;
  manualReview: boolean;
  reasons: string[];
}

/** Pure: route a LIVE, priced record. Manual Review when the list price
 *  exceeds the Detroit ceiling OR the opener lands above the hot-seed fraction
 *  of list; otherwise it stays Review (sendable). Tested. */
export function routeBacklogStatus(
  input: { opener: number | null; listPrice: number | null },
  opts?: { hotSeedPct?: number; listCeilingUsd?: number },
): BacklogRouteVerdict {
  const hotPct = opts?.hotSeedPct ?? HOT_SEED_PCT_OF_LIST;
  const ceiling = opts?.listCeilingUsd ?? DETROIT_LIST_CEILING_USD;
  const reasons: string[] = [];
  const list = typeof input.listPrice === "number" && input.listPrice > 0 ? input.listPrice : null;
  if (list != null && list > ceiling) {
    reasons.push(`list $${Math.round(list).toLocaleString()} > $${ceiling.toLocaleString()} ceiling (luxury)`);
  }
  if (input.opener != null && list != null && input.opener > hotPct * list) {
    reasons.push(`opener ${Math.round((100 * input.opener) / list)}% > ${Math.round(hotPct * 100)}% of list (hot-seed)`);
  }
  const manualReview = reasons.length > 0;
  return { route: manualReview ? "manual_review" : "review", manualReview, reasons };
}
