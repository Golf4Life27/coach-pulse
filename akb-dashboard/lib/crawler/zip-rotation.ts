// ZIP scheduling for the intake cron.
//
// Problem 1 (2026-06-08): the cron scanned every eligible ZIP every day
// and stalled when calls_needed > per-run cap (54 ZIPs vs cap 30 →
// six-day intake outage). First fix: daily rotation slice
// (selectDailyZipSlice).
//
// Problem 2 (2026-06-08, same day): the 30-ZIP daily slice itself hit
// FUNCTION_INVOCATION_TIMEOUT (300s) — too many ZIPs' worth of
// Firecrawl+RentCast+classify for one invocation. Fix forward via
// FREQUENCY, not slice size: a small per-invocation cap + a frequent
// cron, each run advancing a FRESHNESS CURSOR. selectDueZips is that
// cursor — it returns the N stalest "due" ZIPs (null or older than the
// cycle window), so many small runs cover the registry, each run is
// bounded, and a partial/failed run leaves its un-freshened ZIPs due
// for the next run (idempotent, self-advancing, partial-safe).
//
// Both selectors are pure + deterministic for testability.

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

// ── Freshness-cursor scheduling (2026-06-08 timeout fix) ──────────────

export interface ZipDueRow {
  zip: string;
  /** ISO timestamp of last successful ingest, or null if never. */
  lastIngestedAt: string | null;
}

export interface ZipDueResult {
  /** The (up to) `cap` stalest DUE ZIPs, oldest-first. The set this
   *  invocation should process. */
  selected: string[];
  /** Total ZIPs currently due (null or stale) BEFORE the cap is applied. */
  dueTotal: number;
  /** Total ZIPs already fresh this cycle (skipped — the "never recompute
   *  a ZIP already done this cycle" guarantee). */
  freshTotal: number;
  cap: number;
  cycleHours: number;
  /** Runs of `cap` needed to clear the current due backlog. */
  runsToClearBacklog: number;
}

/** Pure: select the N stalest DUE ZIPs for THIS invocation.
 *
 *  A ZIP is "due" when its lastIngestedAt is null (never ingested) OR
 *  older than `cycleHours` ago. Due ZIPs are sorted oldest-first (null =
 *  oldest) and the first `cap` are returned.
 *
 *  Idempotent within a cycle: a ZIP freshened < cycleHours ago is NOT
 *  due, so re-running never re-digs it. Self-advancing: each run freshens
 *  up to `cap`, shrinking the due set; the next run picks the next stalest.
 *  Partial-safe: a ZIP that errored (no lastIngestedAt write) stays due.
 *
 *  cap <= 0 → empty (caller treats as no-op). */
export function selectDueZips(
  rows: ZipDueRow[],
  cap: number,
  now: Date,
  cycleHours: number,
): ZipDueResult {
  const cutoff = now.getTime() - cycleHours * 3_600_000;
  // Dedup by zip (registry is one-row-per-zip, but be defensive), keeping
  // the OLDEST lastIngestedAt seen for a zip.
  const byZip = new Map<string, number>(); // zip → lastIngested ms (-Infinity = null/never)
  for (const r of rows) {
    if (!/^\d{5}$/.test(r.zip)) continue;
    const t = r.lastIngestedAt ? Date.parse(r.lastIngestedAt) : Number.NEGATIVE_INFINITY;
    const ms = Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
    const prev = byZip.get(r.zip);
    if (prev === undefined || ms < prev) byZip.set(r.zip, ms);
  }

  const all = [...byZip.entries()].map(([zip, ms]) => ({ zip, ms }));
  const due = all.filter((z) => z.ms < cutoff); // null (-Infinity) always due
  const freshTotal = all.length - due.length;

  // Oldest-first; tie-break by zip for deterministic ordering.
  due.sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.zip < b.zip ? -1 : 1));

  const effectiveCap = cap > 0 ? cap : 0;
  const selected = due.slice(0, effectiveCap).map((z) => z.zip);

  return {
    selected,
    dueTotal: due.length,
    freshTotal,
    cap: effectiveCap,
    cycleHours,
    runsToClearBacklog: effectiveCap > 0 ? Math.ceil(due.length / effectiveCap) : 0,
  };
}
