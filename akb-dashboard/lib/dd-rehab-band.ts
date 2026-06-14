// DD-narrowed rehab band (spine recZ6tBZRmfFOLwqo). @agent: appraiser
//
// Photos NARROW it to a band. DD answers PIN it (collapse the band).
// Walkthrough RESOLVES it. This module is stage 2: take the vision-
// derived starting band + the per-mechanical age signals, return a
// narrower band + a confidence label.
//
// What we DON'T do here: invent a number to the dollar. The honest
// output is still a band; we're just narrower than the photos-only
// version. A rehab band wider than ±25% at contract stage is the same
// as no rehab data and must HOLD per SYSTEM_HANDOFF.md.

import type { DDRehabSignals, AgeBucket, Mechanical } from "@/lib/dd-rehab-signals";

export interface RehabBand {
  low: number;
  mid: number;
  high: number;
  source: "photos_only" | "photos_plus_dd" | "walkthrough";
  /** Half-width as fraction of mid. > 0.25 at contract stage = HOLD. */
  widthPct: number;
  /** Plain-English explanation surfaced on the deal page. */
  rationale: string;
}

// Per-mechanical adjustment to the rehab MID, expressed as a fraction
// of the photos-only mid. These are CONSERVATIVE deltas — a knob &
// tube electrical rewire on a 1929 Detroit bungalow runs $8-15k;
// 4% of a $30k mid is $1,200 which is too low for the dollar impact
// but right for the BAND-NARROWING (each answer should shrink the
// band's uncertainty, not single-handedly move the center). The
// operator can retune these constants once we have signal.
const ADJUSTMENT_PCT: Record<Mechanical, { up: number; down: number }> = {
  roof:         { up: 0.08, down: 0.05 },
  hvac:         { up: 0.06, down: 0.04 },
  waterHeater:  { up: 0.02, down: 0.01 },
  electrical:   { up: 0.10, down: 0.06 },
  plumbing:     { up: 0.08, down: 0.05 },
};

/** Pure: narrow the rehab band using DD-extracted mechanical signals.
 *  Each answered mechanical:
 *    - shrinks the half-width by 15% (uncertainty reduction)
 *    - nudges the mid up or down by ADJUSTMENT_PCT depending on bucket
 *  Unknown answers do nothing — silence is not a signal. */
export function narrowRehabBandFromDD(
  startBand: { low: number; mid: number; high: number },
  signals: DDRehabSignals,
): RehabBand {
  let mid = startBand.mid;
  // Treat the starting half-width as the photos-only uncertainty.
  let halfWidth = (startBand.high - startBand.low) / 2;
  const rationaleParts: string[] = [];

  const mechs: Mechanical[] = ["roof", "hvac", "waterHeater", "electrical", "plumbing"];
  for (const m of mechs) {
    const s = signals[m];
    if (s.bucket === "unknown") continue;
    const adj = ADJUSTMENT_PCT[m];
    if (s.bucket === "original_pre1980") {
      const delta = Math.round(mid * adj.up);
      mid += delta;
      rationaleParts.push(`${m} original/pre-1980 (+$${delta.toLocaleString()})`);
    } else if (s.bucket === "updated_post1980") {
      const delta = Math.round(mid * adj.down);
      mid -= delta;
      rationaleParts.push(`${m} updated (−$${delta.toLocaleString()})`);
    }
    // Each answered mechanical shrinks remaining uncertainty.
    halfWidth = halfWidth * 0.85;
  }

  mid = Math.max(0, Math.round(mid));
  halfWidth = Math.max(1_000, Math.round(halfWidth));
  const low = Math.max(0, mid - halfWidth);
  const high = mid + halfWidth;
  const widthPct = mid > 0 ? halfWidth / mid : 1;

  const source: RehabBand["source"] = signals.answeredCount > 0 ? "photos_plus_dd" : "photos_only";
  const rationale =
    rationaleParts.length === 0
      ? `Photos only — band ±${Math.round(widthPct * 100)}% of mid; ask roof/HVAC/water heater/electrical/plumbing ages to narrow.`
      : `Photos + ${signals.answeredCount}/5 DD answers: ${rationaleParts.join(", ")}; band ±${Math.round(widthPct * 100)}% of mid.`;

  return { low, mid, high, source, widthPct, rationale };
}

/** Returns the rehab band given a known walkthrough number. The walkthrough
 *  is the ground truth: ±10% reflects contractor variance, not estimator
 *  uncertainty. */
export function walkthroughBand(walkthroughEstimate: number): RehabBand {
  const mid = Math.round(walkthroughEstimate);
  const halfWidth = Math.round(mid * 0.10);
  return {
    low: mid - halfWidth,
    mid,
    high: mid + halfWidth,
    source: "walkthrough",
    widthPct: 0.10,
    rationale: `Walkthrough scoped: $${mid.toLocaleString()} ±10% (contractor variance).`,
  };
}
