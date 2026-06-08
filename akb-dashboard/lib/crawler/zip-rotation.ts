// ZIP-rotation slicer for the daily intake cron.
//
// Problem (2026-06-08): the cron scans every eligible ZIP in
// ZIP_Registry every day and stalls when calls_needed > per-run cap.
// Adding 30 Detroit ZIPs on 6/7 took the registry from 24 to 54 and
// blew past RENTCAST_INTAKE_MAX_CALLS_PER_RUN=30 → six-day total
// intake outage.
//
// Fix: rotate. Pick a deterministic daily slice of N ZIPs (N = the
// per-run cap), advancing through the sorted registry. A 54-ZIP
// registry with N=30 sweeps the full set every 2 days, never stalls,
// and gives the foundations cross-market exposure (this is the "even
// 5 ZIPs/day rotated across TX/TN/MI/etc" breadth tax I'd recommended
// earlier — same mechanism, derived from the bug fix).
//
// Pure + deterministic per (date, allZips, dailyCap) so the same day
// always picks the same slice (idempotent re-fires; testable).

/** Days since unix epoch (UTC midnight). Used as the rotation cursor —
 *  advances by exactly 1 each daily cron tick. */
export function utcDayIndex(now: Date): number {
  return Math.floor(now.getTime() / 86_400_000);
}

export interface ZipSliceResult {
  /** Today's ZIPs (subset of input, original sort order). */
  selected: string[];
  /** Start index in the sorted input list for diagnostic / Spine logging. */
  startIndex: number;
  /** Total eligible ZIPs in the registry. */
  totalEligible: number;
  /** Days to sweep the full registry at this cap. */
  cycleDays: number;
  /** True when the slice wrapped around end-of-list back to the start. */
  wrapped: boolean;
}

/** Pure: deterministic rotation slicer.
 *  - If totalEligible ≤ dailyCap, returns the full list (no rotation needed).
 *  - Otherwise selects `dailyCap` ZIPs starting at (dayIndex * dailyCap) %
 *    totalEligible, wrapping if needed.
 *  - dailyCap ≤ 0 → empty result (callers should treat as "no fetches today");
 *    a sane caller passes the cron's per-run cap. */
export function selectDailyZipSlice(
  allZipsSorted: string[],
  dailyCap: number,
  now: Date,
): ZipSliceResult {
  const total = allZipsSorted.length;
  if (total === 0 || dailyCap <= 0) {
    return { selected: [], startIndex: 0, totalEligible: total, cycleDays: 0, wrapped: false };
  }
  if (total <= dailyCap) {
    return {
      selected: [...allZipsSorted],
      startIndex: 0,
      totalEligible: total,
      cycleDays: 1,
      wrapped: false,
    };
  }
  const dayIdx = utcDayIndex(now);
  const startIndex = (dayIdx * dailyCap) % total;
  const end = startIndex + dailyCap;
  let selected: string[];
  let wrapped = false;
  if (end <= total) {
    selected = allZipsSorted.slice(startIndex, end);
  } else {
    // Wrap: tail of list + head.
    selected = [...allZipsSorted.slice(startIndex), ...allZipsSorted.slice(0, end - total)];
    wrapped = true;
  }
  return {
    selected,
    startIndex,
    totalEligible: total,
    cycleDays: Math.ceil(total / dailyCap),
    wrapped,
  };
}
