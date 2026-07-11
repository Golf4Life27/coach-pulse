// North-star pace math (silver-platter cockpit header).
//
// The counter (live negotiations this month, PR #84) is Chicago-calendar
// month-to-date; the pace ladder is the operator's 10 → 20 → 50 /month.
// Honest math only: expected-to-date = target × month-fraction-elapsed; the
// projection is the straight-line month-end extrapolation, labeled as a
// projection. PURE — the header supplies the clock.

export const PACE_TARGETS = [10, 20, 50] as const;

export interface PaceTargetVerdict {
  target: number;
  /** target × fraction of the month elapsed, one decimal. */
  expectedToDate: number;
  onPace: boolean;
}

export interface PaceVerdict {
  count: number;
  /** 0..1 — fraction of the Chicago calendar month elapsed. */
  monthFraction: number;
  targets: PaceTargetVerdict[];
  /** "on pace for 20/mo" | "below 10/mo pace" */
  headline: string;
  /** Straight-line month-end projection (count ÷ fraction), rounded. */
  projected: number;
  tone: "good" | "warning" | "behind";
}

function chicagoParts(now: Date): { day: number; daysInMonth: number; hour: number } {
  const c = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const daysInMonth = new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate();
  return { day: c.getDate(), daysInMonth, hour: c.getHours() };
}

export function northStarPace(count: number, now: Date): PaceVerdict {
  const { day, daysInMonth, hour } = chicagoParts(now);
  const monthFraction = Math.min(1, Math.max(1 / (daysInMonth * 24), (day - 1 + hour / 24) / daysInMonth));

  const targets: PaceTargetVerdict[] = PACE_TARGETS.map((t) => {
    const expected = Math.round(t * monthFraction * 10) / 10;
    return { target: t, expectedToDate: expected, onPace: count >= expected };
  });

  // A zero count is never "on pace" — at month start 0 ≥ 0-expected is
  // mathematically true and humanly misleading. Zero early = too soon to
  // judge; zero once the 10/mo rung expects ≥1 = behind.
  const best = count > 0 ? ([...targets].reverse().find((t) => t.onPace) ?? null) : null;
  let headline: string;
  let tone: PaceVerdict["tone"];
  if (best) {
    headline = `on pace for ${best.target}/mo`;
    tone = best.target >= 20 ? "good" : "warning";
  } else if (count === 0 && targets[0].expectedToDate < 1) {
    headline = "month just started";
    tone = "warning";
  } else {
    headline = "below 10/mo pace";
    tone = "behind";
  }
  const projected = Math.round(count / monthFraction);

  return { count, monthFraction, targets, headline, projected, tone };
}
