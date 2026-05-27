// ZIP market-saturation policy (Workstream D1 — 24.5). Pure logic only;
// the zip-saturation-check cron does the I/O (read ZIP_Daily_Stats rolling
// aggregates, write ZIP_Registry).
//
// A ZIP is "below threshold" on a given day when it has enough samples to
// judge (considered > 0 over the rolling window) AND its rolling accept
// rate is under that ZIP's Saturation_Threshold. The streak counts
// CONSECUTIVE below-threshold days; one good day resets it to 0. When the
// streak reaches SATURATION_STREAK_DAYS (default 14) an *active* ZIP flips
// to `saturated` — the market is tapped out, stop spending intake budget on
// it and surface an expansion suggestion via Pulse.
//
// Days with no samples (considered === 0, e.g. RentCast returned nothing or
// the ZIP was paused) are INDETERMINATE — they neither extend nor reset the
// streak, so a quiet feed doesn't manufacture or erase a saturation signal.

import type { MarketTier } from "./zip-registry";

export const DEFAULT_SATURATION_THRESHOLD = 0.01; // fraction (1%)
export const DEFAULT_STREAK_DAYS = 14;
export const DEFAULT_WINDOW_DAYS = 30;

export interface SaturationEvalInput {
  /** Rolling accept rate over the window, or null when no candidates were
   *  considered (indeterminate). */
  acceptRate: number | null;
  /** Candidates considered over the window — 0 means indeterminate. */
  considered: number;
  /** This ZIP's Saturation_Threshold (fraction); null → default. */
  threshold: number | null;
  /** Streak carried from the prior run (ZIP_Registry). */
  previousStreak: number;
  /** Consecutive below-threshold days that trigger a flip. */
  streakThreshold: number;
  /** Current tier — only `active` ZIPs flip to `saturated`. */
  tier: MarketTier | null;
}

export interface SaturationEval {
  evaluable: boolean; // had enough samples to judge this run
  belowThreshold: boolean;
  newStreak: number;
  /** True when this run pushes an active ZIP to the saturated flip. */
  shouldSaturate: boolean;
  thresholdUsed: number;
}

export function evaluateSaturation(input: SaturationEvalInput): SaturationEval {
  const thresholdUsed =
    input.threshold != null && input.threshold > 0 ? input.threshold : DEFAULT_SATURATION_THRESHOLD;
  const evaluable = input.considered > 0 && input.acceptRate != null;
  const belowThreshold = evaluable && (input.acceptRate as number) < thresholdUsed;

  // Indeterminate day: carry the streak unchanged. Below: extend. Good day: reset.
  let newStreak: number;
  if (!evaluable) newStreak = input.previousStreak;
  else if (belowThreshold) newStreak = input.previousStreak + 1;
  else newStreak = 0;

  const shouldSaturate = input.tier === "active" && newStreak >= input.streakThreshold;
  return { evaluable, belowThreshold, newStreak, shouldSaturate, thresholdUsed };
}
