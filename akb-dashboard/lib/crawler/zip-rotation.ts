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

// ── Yield-aware cadence (chew-and-move-on, operator /goal 2026-07-22) ──
//
// THE PROBLEM: the flat freshness cursor recrawls every registry ZIP on
// the same cycle forever. A metro that has already been swept ("chewed")
// keeps eating the same crawl budget as a fresh metro, even though its
// standing stock of aged-DOM/price-cut inventory was captured on the
// first pass and only a trickle of newly-aged listings appears after.
// Meanwhile fresh metros — each carrying a WHOLE backlog of distressed
// inventory — wait behind the even rotation. Volume dies in the middle.
//
// THE FIX: per-ZIP recrawl intervals derived from observed yield.
//   - never-crawled ZIPs are always due and sort first (first-pass sweep
//     of a fresh metro is the highest-yield crawl in the system);
//   - producing ZIPs (latest snapshot ingested/accepted > 0) stay on the
//     base cycle;
//   - zero-yield ZIPs cool to a 3-day cycle, then decay to weekly after
//     a sustained zero-yield streak (the "chewed" state — come back
//     later, cheaply);
//   - opener-HOLD markets (non-disclosure states like TX, configured-but-
//     unverified markets) idle at a biweekly trickle: their listings
//     cannot price → cannot send, so recrawling them at full pace burns
//     RentCast budget with zero outreach yield. The trickle keeps the
//     registry stats warm for the day the market unlocks.
//
// Freed budget flows to fresh/staged ZIPs via the same oldest-first
// cursor — no new scheduler, just honest per-row cycle lengths. All the
// spend brakes (daily crawl meter, per-run cap, RentCast quota gate,
// Firecrawl breaker) sit UNDER this policy unchanged.
//
// Pure. The route computes `openerHold` (lib/markets/registry) and reads
// yield fields off ZIP_Registry; this module never does I/O.

/** Cooling cycle for a ZIP whose latest crawl yielded nothing. */
export const COOLING_CYCLE_HOURS = 72;
/** Chewed cycle — sustained zero yield; weekly re-check catches newly
 *  aged-DOM inventory without re-eating daily budget. */
export const CHEWED_CYCLE_HOURS = 168;
/** Opener-HOLD trickle — market can't price/send; biweekly stats-warming. */
export const OPENER_HOLD_CYCLE_HOURS = 336;
/** Consecutive zero-yield ingest runs before a ZIP counts as chewed. */
export const CHEWED_STREAK_RUNS = 3;

export interface ZipCadenceRow {
  zip: string;
  lastIngestedAt: string | null;
  /** Latest-run snapshot: records ingested (ZIP_Registry Records_Ingested_30d). */
  recordsIngested: number | null;
  /** Latest-run snapshot accept rate fraction (Accept_Rate_30d). */
  acceptRate: number | null;
  /** Consecutive zero-yield ingest runs (Below_Threshold_Streak_Days). */
  zeroYieldStreak: number | null;
  /** The opener cannot price this market (openerArvPctMax == null):
   *  non-disclosure state, configured-but-unverified market, etc. */
  openerHold: boolean;
}

/** Pure: the recrawl interval this ZIP has earned. */
export function recrawlCycleHours(row: ZipCadenceRow, baseCycleHours: number): number {
  if (row.openerHold) return Math.max(baseCycleHours, OPENER_HOLD_CYCLE_HOURS);
  if (row.lastIngestedAt == null) return baseCycleHours; // never crawled — always due anyway
  const producing = (row.recordsIngested ?? 0) > 0 || (row.acceptRate ?? 0) > 0;
  if (producing) return baseCycleHours;
  const streak = Math.max(0, Math.floor(row.zeroYieldStreak ?? 0));
  if (streak >= CHEWED_STREAK_RUNS) return Math.max(baseCycleHours, CHEWED_CYCLE_HOURS);
  return Math.max(baseCycleHours, COOLING_CYCLE_HOURS);
}

export interface ZipDueTieredResult extends ZipDueResult {
  /** Diagnostic: how many of the DUE set were never-crawled ZIPs. */
  dueNeverCrawled: number;
  /** Diagnostic: due counts by cadence bucket for the audit trail. */
  dueByCadence: { base: number; cooling: number; chewed: number; opener_hold: number };
}

/** Pure: tiered freshness cursor. Same contract as selectDueZips — the N
 *  stalest DUE ZIPs, oldest-first, never-crawled (null) first — but each
 *  row is due against ITS OWN earned cycle instead of one global window.
 *  Idempotent within each row's cycle; partial-safe (an errored ZIP keeps
 *  its old stamp and stays due). */
export function selectDueZipsTiered(
  rows: ZipCadenceRow[],
  cap: number,
  now: Date,
  baseCycleHours: number,
): ZipDueTieredResult {
  // Dedup by zip, keeping the OLDEST lastIngestedAt seen (defensive).
  const byZip = new Map<string, { row: ZipCadenceRow; ms: number }>();
  for (const r of rows) {
    if (!/^\d{5}$/.test(r.zip)) continue;
    const t = r.lastIngestedAt ? Date.parse(r.lastIngestedAt) : Number.NEGATIVE_INFINITY;
    const ms = Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
    const prev = byZip.get(r.zip);
    if (prev === undefined || ms < prev.ms) byZip.set(r.zip, { row: r, ms });
  }

  const nowMs = now.getTime();
  const due: Array<{ zip: string; ms: number; bucket: keyof ZipDueTieredResult["dueByCadence"] }> = [];
  let freshTotal = 0;
  const dueByCadence = { base: 0, cooling: 0, chewed: 0, opener_hold: 0 };
  for (const { row, ms } of byZip.values()) {
    const cycleH = recrawlCycleHours(row, baseCycleHours);
    if (ms >= nowMs - cycleH * 3_600_000) {
      freshTotal++;
      continue;
    }
    const bucket: keyof typeof dueByCadence = row.openerHold
      ? "opener_hold"
      : cycleH >= CHEWED_CYCLE_HOURS
        ? "chewed"
        : cycleH >= COOLING_CYCLE_HOURS
          ? "cooling"
          : "base";
    dueByCadence[bucket]++;
    due.push({ zip: row.zip, ms, bucket });
  }

  // Oldest-first (never-crawled = -Infinity sorts first); tie-break by zip.
  due.sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.zip < b.zip ? -1 : 1));

  const effectiveCap = cap > 0 ? cap : 0;
  const selected = due.slice(0, effectiveCap).map((z) => z.zip);

  return {
    selected,
    dueTotal: due.length,
    freshTotal,
    cap: effectiveCap,
    cycleHours: baseCycleHours,
    runsToClearBacklog: effectiveCap > 0 ? Math.ceil(due.length / effectiveCap) : 0,
    dueNeverCrawled: due.filter((d) => d.ms === Number.NEGATIVE_INFINITY).length,
    dueByCadence,
  };
}
