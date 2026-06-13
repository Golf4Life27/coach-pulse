// Adaptive per-market anchor calibration (operator brief 2026-06-13,
// spine recZ6tBZRmfFOLwqo). Silent, audit-only, never alerts the
// operator. @agent: crier
//
// THE LOOP:
//   Each market establishes a baseline reply rate over its first 14
//   days OR first 200 sends (whichever lands first). Anchor frozen at
//   0.90 during baseline — we cannot judge above/below normal before
//   normal exists.
//
//   After baseline: each weekly cycle measures the trailing 7-day reply
//   rate (raw inbound / sends). Anchor steps:
//     - within ±20% of baseline → hold or drop 1 point (calibration
//       favors operator margin when the signal is noisy)
//     - notably above baseline (≥20% over) → drop 5 points (we're
//       leaving fee on the table; pull back toward MAO)
//     - near zero / well below baseline (≤50% of baseline) → raise 5
//       points (the opener isn't getting heard; loosen)
//
//   Gates:
//     - Sample gate: 50 sends since the last anchor change. Below that,
//       hold. We will not move on a thin sample.
//     - Hard ceiling 1.00 on autopilot. Crossing requires explicit
//       operator approval.
//     - Hard floor 0.75.
//     - Circuit breaker: pinned at 1.00 with near-zero replies across
//       2 consecutive cycles → stop moving the market, write an
//       operator-review audit row. Likely the market is unworkable at
//       a penciling price, or its arv_pct_max is wrong.
//
// Every move writes audit: market, old anchor, new anchor, reply rate,
// reason. Never surfaces to UI, never sends an alert.

import {
  ANCHOR_AUTOPILOT_CEILING,
  ANCHOR_FLOOR,
  DEFAULT_ANCHOR_PCT,
  type MarketAnchorState,
} from "./anchor";

/** Sample size required before any post-baseline anchor move. */
export const SAMPLE_GATE = 50;

/** Baseline horizon: whichever lands first. */
export const BASELINE_DAYS = 14;
export const BASELINE_SENDS = 200;

/** Step sizes (anchor points). 1 point = 0.01. */
export const STEP_HOLD = 0.00;
export const STEP_SMALL_DROP = -0.01;
export const STEP_DROP = -0.05;
export const STEP_RAISE = 0.05;

/** Band classifying current vs baseline reply rate. */
export const ABOVE_BASELINE_PCT = 1.20; // ≥20% above baseline → drop_5
export const NEAR_ZERO_VS_BASELINE_PCT = 0.50; // ≤50% of baseline → raise_5

/** Consecutive ceiling-pin cycles before the circuit breaker trips. */
export const BREAKER_CYCLES = 2;
/** "Near zero" reply rate (absolute) for the breaker test. */
export const BREAKER_NEAR_ZERO_REPLY_RATE = 0.02;

export interface CalibrationSample {
  /** Total sends in the cycle window (weekly). */
  sends: number;
  /** Total raw inbound replies attributable to those sends. */
  replies: number;
  /** Engaged replies (L3 Negotiating-classified) — audit-only secondary
   *  metric, never drives the step itself. */
  engagedReplies: number;
}

export type CalibrationReason =
  | "below_sample_gate"     // <50 sends since last change → hold
  | "below_baseline_gate"   // baseline not established → hold
  | "broken_market"         // breaker tripped earlier → hold
  | "within_band"           // reply rate in normal band → tiny drop
  | "above_baseline"        // ≥20% above baseline → drop 5
  | "near_zero_below_baseline" // ≤50% of baseline → raise 5
  | "baseline_established"  // baseline horizon hit this cycle → no move
  | "ceiling_pinned"        // already at ceiling, can't raise
  | "floor_pinned";         // already at floor, can't drop

export interface CalibrationDecision {
  /** The new anchor to write — equals old when no move. */
  newAnchorPct: number;
  /** Step actually applied (post-clamp). May be 0 even when the rule
   *  said to move (e.g. clamp at floor/ceiling). */
  appliedStep: number;
  reason: CalibrationReason;
  /** Set when the breaker tripped THIS cycle. The caller writes an
   *  operator-review audit row (still silent, no UI alert). */
  breakerTrippedThisCycle: boolean;
  /** Inputs read from the sample, surfaced for the audit. */
  metrics: {
    replyRate: number;
    engagedReplyRate: number;
    baselineReplyRate: number | null;
    daysSinceBaselineStart: number;
    sendsSinceLastChange: number;
  };
}

function replyRate(s: CalibrationSample): number {
  if (s.sends <= 0) return 0;
  return s.replies / s.sends;
}

function engagedReplyRate(s: CalibrationSample): number {
  if (s.sends <= 0) return 0;
  return s.engagedReplies / s.sends;
}

function daysBetween(from: string | null, now: Date): number {
  if (!from) return 0;
  const t = Date.parse(from);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((now.getTime() - t) / (24 * 3600 * 1000));
}

/** Pure: should this market's baseline be considered established? Trips
 *  the moment EITHER side of the brief's "14 days OR 200 sends" lands. */
export function isBaselineEstablished(
  state: MarketAnchorState,
  cumulativeSends: number,
  now: Date,
): boolean {
  if (state.baselineReplyRate != null) return true;
  const days = daysBetween(state.baselineStartedAt, now);
  return days >= BASELINE_DAYS || cumulativeSends >= BASELINE_SENDS;
}

/** Pure: apply one calibration cycle. Caller saves the state + writes
 *  audit. The cycle's reply rate IS the baseline-establishment value
 *  when the horizon hits this cycle. */
export function decideAnchorMove(
  state: MarketAnchorState,
  /** Trailing cycle-window sample (typically 7 days). */
  cycleSample: CalibrationSample,
  /** Cumulative sends in the baseline window — only consulted before
   *  baseline is established. */
  cumulativeSends: number,
  now: Date = new Date(),
): CalibrationDecision {
  const old = state.anchorPct;
  const cycleReplyRate = replyRate(cycleSample);
  const cycleEngagedReplyRate = engagedReplyRate(cycleSample);
  const daysSince = daysBetween(state.baselineStartedAt, now);

  const baseMetrics = {
    replyRate: cycleReplyRate,
    engagedReplyRate: cycleEngagedReplyRate,
    baselineReplyRate: state.baselineReplyRate,
    daysSinceBaselineStart: daysSince,
    sendsSinceLastChange: state.sendsSinceLastChange,
  };

  // Broken markets stay frozen until operator intervention.
  if (state.brokenAt) {
    return {
      newAnchorPct: old,
      appliedStep: 0,
      reason: "broken_market",
      breakerTrippedThisCycle: false,
      metrics: baseMetrics,
    };
  }

  // Baseline gate — anchor frozen at default until the horizon hits.
  if (state.baselineReplyRate == null) {
    if (!isBaselineEstablished(state, cumulativeSends, now)) {
      return {
        newAnchorPct: old,
        appliedStep: 0,
        reason: "below_baseline_gate",
        breakerTrippedThisCycle: false,
        metrics: baseMetrics,
      };
    }
    // Baseline established THIS cycle — record the current cycle's reply
    // rate as the baseline, no anchor move (need to compare against
    // baseline in future cycles, not against ourselves).
    return {
      newAnchorPct: old,
      appliedStep: 0,
      reason: "baseline_established",
      breakerTrippedThisCycle: false,
      metrics: { ...baseMetrics, baselineReplyRate: cycleReplyRate },
    };
  }

  // Sample gate — won't move on thin evidence.
  if (state.sendsSinceLastChange < SAMPLE_GATE) {
    return {
      newAnchorPct: old,
      appliedStep: 0,
      reason: "below_sample_gate",
      breakerTrippedThisCycle: false,
      metrics: baseMetrics,
    };
  }

  // Step rules.
  const baseline = state.baselineReplyRate;
  let step = STEP_HOLD;
  let reason: CalibrationReason;

  if (cycleReplyRate <= NEAR_ZERO_VS_BASELINE_PCT * baseline || cycleReplyRate <= BREAKER_NEAR_ZERO_REPLY_RATE) {
    step = STEP_RAISE;
    reason = "near_zero_below_baseline";
  } else if (cycleReplyRate >= ABOVE_BASELINE_PCT * baseline) {
    step = STEP_DROP;
    reason = "above_baseline";
  } else {
    step = STEP_SMALL_DROP;
    reason = "within_band";
  }

  let next = old + step;
  // Clamp + record floor/ceiling pinning.
  let pinnedAtCeiling = false;
  let pinnedAtFloor = false;
  if (next > ANCHOR_AUTOPILOT_CEILING) {
    next = ANCHOR_AUTOPILOT_CEILING;
    pinnedAtCeiling = true;
    if (old >= ANCHOR_AUTOPILOT_CEILING) reason = "ceiling_pinned";
  }
  if (next < ANCHOR_FLOOR) {
    next = ANCHOR_FLOOR;
    pinnedAtFloor = true;
    if (old <= ANCHOR_FLOOR) reason = "floor_pinned";
  }

  // Circuit breaker — at the autopilot ceiling AND replies still near
  // zero across 2 consecutive cycles. The brief: stop moving silently.
  const stillNearZero = cycleReplyRate <= BREAKER_NEAR_ZERO_REPLY_RATE;
  let breakerTrippedThisCycle = false;
  if (next >= ANCHOR_AUTOPILOT_CEILING && stillNearZero) {
    if (state.pinAtCeilingCycles + 1 >= BREAKER_CYCLES) {
      breakerTrippedThisCycle = true;
    }
  }

  const appliedStep = Math.round((next - old) * 1_000_000) / 1_000_000; // float hygiene
  return {
    newAnchorPct: Math.round(next * 100) / 100, // anchor stored to 2 decimals
    appliedStep,
    reason,
    breakerTrippedThisCycle,
    metrics: baseMetrics,
  };
}

/** Pure: apply a decision to a state, advancing the bookkeeping fields. */
export function applyDecision(
  state: MarketAnchorState,
  decision: CalibrationDecision,
  now: Date = new Date(),
): MarketAnchorState {
  const moved = decision.newAnchorPct !== state.anchorPct;
  const pinnedAtCeiling = decision.newAnchorPct >= ANCHOR_AUTOPILOT_CEILING && decision.metrics.replyRate <= BREAKER_NEAR_ZERO_REPLY_RATE;
  return {
    ...state,
    anchorPct: decision.newAnchorPct,
    baselineReplyRate:
      decision.reason === "baseline_established"
        ? decision.metrics.replyRate
        : state.baselineReplyRate,
    sendsSinceLastChange: moved ? 0 : state.sendsSinceLastChange,
    lastAnchorChangeAt: moved ? now.toISOString() : state.lastAnchorChangeAt,
    pinAtCeilingCycles: pinnedAtCeiling ? state.pinAtCeilingCycles + 1 : 0,
    brokenAt: decision.breakerTrippedThisCycle ? now.toISOString() : state.brokenAt,
  };
}

// Mute unused-warning for exports kept for tests/consumers.
void DEFAULT_ANCHOR_PCT;
