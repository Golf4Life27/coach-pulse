// Maverick — RentCast burn-rate cross-source synthesis.
// @agent: maverick (Day 2 / Finding 3)
//
// The external-rentcast.ts fetcher reports the env-configured monthly
// cap + UTC-anchored reset date. It does NOT compute burn rate
// because that's a cross-source synthesis: we need RentCast's cap
// plus a count of recent calls (from the audit log). This module
// joins those at aggregator time.

import type { RentCastState } from "./sources/external-rentcast";
import type { VercelKvAuditState } from "./sources/vercel-kv-audit";

// ── Consolidation Night 2026-07-29 (item C): HONEST COUNTING ──────────
// Until tonight this meter counted only three pricing-agent event names
// and multiplied by 2 (the 5/13 heuristic from before paid calls were
// individually audited). It was structurally blind to appraiser-backfill,
// auto-underwrite-engaged, seed-sweep, and federation — the crons doing
// ~90% of the actual spending — which is why it reported near-zero burn
// while the vendor billed 6,247 calls against a 1,000/month plan. Every
// RentCast HTTP call now emits its own paid_api_call audit row with
// agent="rentcast" (rentcastPaidFetch is the enforced choke point since
// item B), so the meter simply counts those rows. No multipliers, no
// agent allowlist. Known small overcount: breaker-skipped rows (synthetic
// 599, cost 0) are included — conservative in the safe direction.
const RENTCAST_AUDIT_AGENT = "rentcast";

export interface RentCastBurnRate {
  // RentCast paid_api_call audit rows observed in the window. (Renamed
  // from pricing_calls_in_window, which described the pre-7/29 blind
  // counting method, not the quantity.)
  paid_calls_in_window: number;
  // Kept for shape-compat with briefing consumers; now identical to
  // paid_calls_in_window (the ×2 pricing-agent heuristic is retired).
  estimated_calls_in_window: number;
  // The window size in hours that pricing_calls_in_window covers.
  window_hours: number;
  // Calls per day projected from window observations.
  burn_rate_per_day: number;
  // How many days of quota remain at the current burn rate.
  // null when burn_rate_per_day is 0 (no recent activity), AND null when the
  // window is too short to trust (see MIN_TRUSTED_WINDOW_HOURS).
  days_until_exhaustion_estimate: number | null;
  // Calls remaining in the current billing cycle (capped at 0).
  estimated_calls_remaining: number;
}

export interface ComputeBurnRateInputs {
  rentcast: RentCastState;
  audit: VercelKvAuditState | null;
  // Window the audit data covers. The aggregator passes its since
  // anchor (default 24h ago) so window_hours is exact.
  windowHours: number;
  // Estimated calls already consumed this billing cycle (cap-minus-
  // remaining). For v1 we don't have a quota-burn ledger, so we
  // approximate by extrapolating the windowed rate across days
  // elapsed in the cycle.
  daysElapsedInCycle: number;
  /** ACTUAL calls consumed this cycle, when a real meter is available.
   *  Supersedes the extrapolation entirely — see the note below. */
  actualCallsUsedThisCycle?: number | null;
  /** Clock for the truncation clamp. Injectable for tests; defaults to
   *  wall clock. */
  now?: Date;
}

/** A window shorter than a full day cannot average the daily cron mix.
 *
 *  THE FAILURE, twice now (2026-08-05 and 2026-08-08). burn_rate_per_day is
 *  (calls in window / windowHours) x 24, and the aggregator sets windowHours
 *  from its `since` anchor with a floor of 1. Anchor at 2 hours, catch one
 *  cron burst, and the daily rate comes out ~12x high. That error then
 *  COMPOUNDS, because the inflated rate is used twice in opposite directions:
 *  it inflates estimatedConsumedThisCycle, which shrinks the remaining quota,
 *  and it is also the divisor. A modest burst therefore collapses straight to
 *  "~0d to exhaustion" and pages the operator at Tier 3.
 *
 *  On 2026-08-05 the honest 24h burn was ~93/day (~6 days of headroom) while a
 *  2h slice read ~300/day and fired "~0d".
 *
 *  THE MIRROR FAILURE (2026-08-08, diagnosed): the guard checked the CLAIMED
 *  windowHours, not what the audit data actually covered. The KV audit source
 *  read only its newest page of events (~3h on a busy day) while the
 *  aggregator claimed 24h — so a truncated count divided by the full window
 *  DEFLATED the rate (30/day reported, ~197/day real) and the guard blessed
 *  it. computeBurnRate now clamps the window to the actual data span whenever
 *  the audit read was truncated (read_truncated + oldest_event_ts), which
 *  both corrects the rate and lets this guard see the real, shorter window. */
export const MIN_TRUSTED_WINDOW_HOURS = 24;

/**
 * Pure cross-source synthesis. Tests pass synthetic audit + rentcast
 * objects and assert the joined output.
 */
export function computeBurnRate(opts: ComputeBurnRateInputs): RentCastBurnRate {
  const auditCalls = countRentcastPaidCalls(opts.audit);
  // Honest 1:1 — every RentCast call audits itself since 2026-07-29.
  const estimatedCallsInWindow = auditCalls;

  // A truncated audit read saw only its newest page — the count covers the
  // span back to the oldest event it holds, NOT the claimed window. Rating
  // over the claimed window deflates the burn (the 2026-08-08 failure);
  // clamp to what the data actually covers.
  let effectiveWindowHours = opts.windowHours;
  const audit = opts.audit;
  if (audit?.read_truncated && audit.oldest_event_ts) {
    const nowMs = (opts.now ?? new Date()).getTime();
    const oldestMs = Date.parse(audit.oldest_event_ts);
    if (Number.isFinite(oldestMs) && nowMs > oldestMs) {
      const spanHours = Math.max(1, Math.round((nowMs - oldestMs) / 3_600_000));
      effectiveWindowHours = Math.min(effectiveWindowHours, spanHours);
    }
  }

  const burnPerDay =
    effectiveWindowHours > 0
      ? Math.round((estimatedCallsInWindow / effectiveWindowHours) * 24)
      : 0;

  // Consumed this cycle. PREFER A REAL METER: extrapolating the window rate
  // across days elapsed multiplies any window error by ~8 mid-month, and the
  // same error is then the divisor below. When the caller can tell us what was
  // actually spent, the guess has no business being used.
  const actualUsed = opts.actualCallsUsedThisCycle;
  const haveActual = typeof actualUsed === "number" && Number.isFinite(actualUsed) && actualUsed >= 0;
  const estimatedConsumedThisCycle = haveActual
    ? Math.round(actualUsed as number)
    : Math.max(0, Math.round(burnPerDay * opts.daysElapsedInCycle));
  const estimatedCallsRemaining = Math.max(0, opts.rentcast.monthly_cap - estimatedConsumedThisCycle);

  // Only project from a window wide enough to average the daily cron mix —
  // unless we have a real consumed figure, in which case the remaining side of
  // the division is solid and only the rate is a projection. Judged on the
  // EFFECTIVE window: a truncated read that only covers 3h is a 3h window no
  // matter what the aggregator's anchor claims.
  const windowTrusted = effectiveWindowHours >= MIN_TRUSTED_WINDOW_HOURS;
  const daysUntilExhaustion =
    burnPerDay > 0 && (windowTrusted || haveActual)
      ? Math.floor(estimatedCallsRemaining / burnPerDay)
      : null;

  return {
    paid_calls_in_window: auditCalls,
    estimated_calls_in_window: estimatedCallsInWindow,
    window_hours: effectiveWindowHours,
    burn_rate_per_day: burnPerDay,
    days_until_exhaustion_estimate: daysUntilExhaustion,
    estimated_calls_remaining: estimatedCallsRemaining,
  };
}

/**
 * Count of RentCast paid_api_call audit rows in the audit window — the
 * agent "rentcast" only ever emits paid-call rows (auditPaidCall), so
 * its per-agent event count IS the call count. Returns 0 for null audit
 * (graceful when KV is down).
 */
export function countRentcastPaidCalls(audit: VercelKvAuditState | null): number {
  if (!audit) return 0;
  return audit.recent_events_by_agent[RENTCAST_AUDIT_AGENT] ?? 0;
}

// ── Cron quota gate (Ship 2 — listings-intake) ──────────────────────
//
// Pure gate the listings-intake cron calls before spending RentCast
// quota. Two checks:
//   1. Hard per-run cap: a single run must not make more than perRunCap
//      calls (it makes exactly one /listings/sale call per ZIP).
//   2. Soft weekly-pool check: if a best-effort estimate of remaining
//      quota is available and is below callsNeeded, deny.
// estimatedRemaining is optimistic (the burn-rate consumed estimate only
// counts pricing-agent events, not intake/federation/verify) — so it's a
// soft guard; the per-run cap is the hard one. null = unknown (skip soft).

export type RentcastQuotaReason =
  | "ok"
  | "exceeds_per_run_cap"
  | "insufficient_weekly_remaining"
  // Consolidation Night 2026-07-29 (item C): the meter is honest now, so
  // mid-cycle overage reads as remaining=0 — which is TRUE, but halting
  // the crawler over it would trade the deal funnel for ~1.2¢/call in
  // overage fees while the plan-derived daily governor already enforces
  // forward pacing. A governor-paced caller CONTINUES in overage, loudly.
  | "overage_continue_governor_paced";

export interface RentcastQuotaDecision {
  allowed: boolean;
  reason: RentcastQuotaReason;
  callsNeeded: number;
  perRunCap: number;
  estimatedRemaining: number | null;
}

export function rentcastQuotaAllows(opts: {
  estimatedRemaining: number | null;
  callsNeeded: number;
  perRunCap: number;
  /** Caller declares its run volume is already clamped by the plan-derived
   *  frontier governor (computeDailyCrawlBudget/governRunCap). With honest
   *  metering (2026-07-29) a mid-cycle overage makes remaining=0 until the
   *  billing reset; a governor-paced caller keeps running — audited as
   *  overage_continue_governor_paced so the state is visible — instead of
   *  starving the funnel for the rest of the cycle. Non-governor callers
   *  keep the hard deny. */
  governorPaced?: boolean;
}): RentcastQuotaDecision {
  const { estimatedRemaining, callsNeeded, perRunCap, governorPaced } = opts;
  let reason: RentcastQuotaReason = "ok";
  if (callsNeeded > perRunCap) {
    reason = "exceeds_per_run_cap";
  } else if (
    estimatedRemaining != null &&
    Number.isFinite(estimatedRemaining) &&
    estimatedRemaining < callsNeeded
  ) {
    reason = governorPaced ? "overage_continue_governor_paced" : "insufficient_weekly_remaining";
  }
  const allowed = reason === "ok" || reason === "overage_continue_governor_paced";
  return { allowed, reason, callsNeeded, perRunCap, estimatedRemaining };
}
