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

// Agents whose audit events indicate a RentCast API call. Each call
// to the Pricing Agent under the hood fires TWO RentCast requests
// (getSaleComparables + getRentEstimate), so each audit event counts
// as 2 quota burns. This is the 5/13 observation from Alex.
const PRICING_AGENT_AGENTS = new Set(["pricing-agent", "phase4a", "phase4a-wrapper"]);

export interface RentCastBurnRate {
  // Number of pricing-agent invocations observed in the audit window.
  pricing_calls_in_window: number;
  // Each call burns 2 RentCast quota credits.
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
  const auditCalls = countPricingAgentCalls(opts.audit);
  // Each pricing-agent call hits RentCast twice (sale comps + rent).
  const estimatedCallsInWindow = auditCalls * 2;

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
    pricing_calls_in_window: auditCalls,
    estimated_calls_in_window: estimatedCallsInWindow,
    window_hours: opts.windowHours,
    burn_rate_per_day: burnPerDay,
    days_until_exhaustion_estimate: daysUntilExhaustion,
    estimated_calls_remaining: estimatedCallsRemaining,
  };
}

/**
 * Sum of audit events attributed to any pricing-agent-class agent.
 * Reads from VercelKvAuditState.recent_events_by_agent. Returns 0
 * for null audit (graceful when KV is down).
 */
export function countPricingAgentCalls(audit: VercelKvAuditState | null): number {
  if (!audit) return 0;
  let total = 0;
  for (const [agent, count] of Object.entries(audit.recent_events_by_agent)) {
    if (PRICING_AGENT_AGENTS.has(agent)) total += count;
  }
  return total;
}
