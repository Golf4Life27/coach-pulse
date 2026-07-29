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
  // null when burn_rate_per_day is 0 (no recent activity).
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
}

/**
 * Pure cross-source synthesis. Tests pass synthetic audit + rentcast
 * objects and assert the joined output.
 */
export function computeBurnRate(opts: ComputeBurnRateInputs): RentCastBurnRate {
  const auditCalls = countRentcastPaidCalls(opts.audit);
  // Honest 1:1 — every RentCast call audits itself since 2026-07-29.
  const estimatedCallsInWindow = auditCalls;

  const burnPerDay =
    opts.windowHours > 0
      ? Math.round((estimatedCallsInWindow / opts.windowHours) * 24)
      : 0;

  // Approximation: assume the windowed burn rate has held across the
  // cycle so far. Days-elapsed × per-day burn = estimated consumed.
  const estimatedConsumedThisCycle = Math.max(0, Math.round(burnPerDay * opts.daysElapsedInCycle));
  const estimatedCallsRemaining = Math.max(0, opts.rentcast.monthly_cap - estimatedConsumedThisCycle);

  const daysUntilExhaustion =
    burnPerDay > 0 ? Math.floor(estimatedCallsRemaining / burnPerDay) : null;

  return {
    paid_calls_in_window: auditCalls,
    estimated_calls_in_window: estimatedCallsInWindow,
    window_hours: opts.windowHours,
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
