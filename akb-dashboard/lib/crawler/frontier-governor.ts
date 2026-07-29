// Frontier rotation governor (#37, operator build order 2026-07-09/11).
// @agent: scout
//
// THE PROBLEM (2026-07-11 registry read): 88 ZIPs are registered across 9
// metros, but the intake belt crawled only ~4-6/day (one daily run × the
// conservative per-run cap) — a ~15-day sweep. Detroit core ZIPs sat
// uncrawled since 6/22 while the RentCast plan (1,000 calls/mo, one
// /listings/sale call per ZIP) ran at a fraction of budget. Volume comes
// from the front door; the front door was barely ajar.
//
// THE FIX: derive the crawl pace FROM the budget instead of a static env
// knob. daily_budget ≈ (remaining calls / days left in cycle) − reserve;
// each intake run is clamped to the unspent share of today's budget (KV
// meter). At ~30 crawls/day the 80-odd actionable ZIPs rotate on a ~3-day
// cycle — the "~90 ZIPs inside the RentCast plan" frontier shape — and the
// existing oldest-first freshness cursor (selectDueZips) IS the rotation;
// this module only sizes its appetite.
//
// Also here: the weekly frontier decisions (pure) — staged→launch
// promotion within sustainable capacity (UNLEASH ruling: expansion is
// autonomous within the hard rails) and zero-yield retirement CANDIDATES
// (report/proposal grade only — the *_30d registry stats are latest-run
// snapshots, not true 30-day aggregates, so auto-retiring on them would be
// guessing; INVARIANTS §1 wins over autonomy here).
//
// PURE. No I/O — the intake route supplies the meter reading and clock.

import { recrawlCycleHours } from "./zip-rotation";

export const DEFAULT_RENTCAST_MONTHLY_PLAN = 1000;
/** Daily paid calls held back for non-crawl uses (ZIP seed pulls, probes). */
export const DEFAULT_DAILY_CRAWL_RESERVE = 3;
/** Rotation target — a ZIP should be re-crawled at least this often once
 *  the registry is at frontier scale. Used for capacity math only. */
export const TARGET_CYCLE_DAYS = 3;

const DAY_MS = 86_400_000;

export interface CrawlBudget {
  /** Crawls (RentCast /listings/sale calls) allowed today. */
  dailyBudget: number;
  daysLeftInCycle: number;
  /** Which input the budget was derived from. */
  basis: "estimated_remaining" | "plan_prorata";
  monthlyPlan: number;
  reserve: number;
}

/** Days left in the current UTC calendar month, INCLUDING today. RentCast
 *  resets on the 1st (operator-confirmed: resets Aug 1). */
export function daysLeftInUtcMonth(now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return daysInMonth - now.getUTCDate() + 1;
}

/** Pure: today's crawl budget. Spreads the remaining plan evenly over the
 *  days left in the cycle, minus the seed/probe reserve. When the burn-rate
 *  estimate is unavailable (null), falls back to plan-pro-rata — the flat
 *  plan/days rate — which can never overshoot the plan even if the whole
 *  month runs on the fallback. Never negative. */
export function computeDailyCrawlBudget(input: {
  monthlyPlan: number;
  estimatedRemaining: number | null;
  now: Date;
  reserve?: number;
}): CrawlBudget {
  const reserve = input.reserve ?? DEFAULT_DAILY_CRAWL_RESERVE;
  const daysLeft = daysLeftInUtcMonth(input.now);
  const daysInMonth = new Date(
    Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth() + 1, 0),
  ).getUTCDate();

  let basis: CrawlBudget["basis"];
  let raw: number;
  if (input.estimatedRemaining != null && Number.isFinite(input.estimatedRemaining)) {
    basis = "estimated_remaining";
    raw = Math.floor(Math.max(0, input.estimatedRemaining) / daysLeft);
  } else {
    basis = "plan_prorata";
    raw = Math.floor(input.monthlyPlan / daysInMonth);
  }
  return {
    dailyBudget: Math.max(0, raw - reserve),
    daysLeftInCycle: daysLeft,
    basis,
    monthlyPlan: input.monthlyPlan,
    reserve,
  };
}

export interface RunCapVerdict {
  /** ZIPs this run may crawl (each = one RentCast call). */
  zipCapThisRun: number;
  allowanceLeftToday: number;
  meterReadable: boolean;
  reason: string;
}

/** Pure: clamp a run's ZIP cap to the unspent share of today's budget.
 *  usedToday = null means the KV meter was unreadable — fall back to the
 *  static env cap alone (pre-governor behavior; the per-run hard cap and
 *  the monthly soft quota gate still bound spend). */
export function governRunCap(input: {
  envZipCap: number;
  dailyBudget: number;
  usedToday: number | null;
}): RunCapVerdict {
  const envCap = Math.max(0, Math.floor(input.envZipCap));
  if (input.usedToday == null) {
    return {
      zipCapThisRun: envCap,
      allowanceLeftToday: -1,
      meterReadable: false,
      reason: "daily meter unreadable — env cap only (per-run hard cap still bounds)",
    };
  }
  const left = Math.max(0, input.dailyBudget - Math.max(0, input.usedToday));
  const cap = Math.min(envCap, left);
  return {
    zipCapThisRun: cap,
    allowanceLeftToday: left,
    meterReadable: true,
    reason:
      cap < envCap
        ? `daily budget clamp: ${left} of ${input.dailyBudget} calls left today`
        : `within budget: ${left} of ${input.dailyBudget} calls left today`,
  };
}

/** KV key for today's crawl meter (UTC date). 48h TTL covers the day plus
 *  read-back slack; the meter is advisory (non-atomic add is acceptable —
 *  intake slots are hours apart and the per-run cap is the hard bound). */
export function crawlMeterKey(now: Date): string {
  return `rentcast:intake:calls:${now.toISOString().slice(0, 10)}`;
}
export const CRAWL_METER_TTL_S = 172_800;

// ── Weekly frontier decisions ────────────────────────────────────────────

/** Consecutive zero-yield ingest runs before a ZIP becomes a retirement
 *  CANDIDATE (proposal-grade; operator still approves). Matches the
 *  chewed-cadence threshold's order of magnitude — one empty pass is
 *  expected noise on a 1-3 day rotation, a sustained streak is signal. */
export const RETIRE_MIN_ZERO_YIELD_STREAK = 3;

/** Days a paused ZIP rests before the rotation pass revives it to staged
 *  (operator ruling 2026-07-29: pause is a rest, not an exit). */
export const REVIVAL_COOLDOWN_DAYS = 30;

export interface FrontierZipRow {
  recordId: string;
  zip: string;
  marketTier: string | null;
  wholesaleRestricted: boolean;
  lastIngestedAt: string | null;
  recordsIngested30d: number | null;
  acceptRate30d: number | null;
  /** Market paused at the contract layer (Memphis) — the intake belt already
   *  skips these (isActionableMarket); the capacity math must too, or dead
   *  rows hold seats fresh metros could use. Route-computed; defaults false. */
  pausedMarket?: boolean;
  /** Opener cannot price this market (non-disclosure TX etc.) — idles at the
   *  biweekly trickle cadence, costing ~1/14th of a producing ZIP. */
  openerHold?: boolean;
  /** Consecutive zero-yield ingest runs (Below_Threshold_Streak_Days). */
  zeroYieldStreak?: number | null;
  /** When the ZIP was paused (Paused_At). Read by the revival decision —
   *  paused past the cooldown returns to staged. Null on non-paused rows
   *  and on rows paused before the field existed (2026-07-29); legacy
   *  paused rows with no stamp are treated as cooldown-elapsed so they
   *  are not stranded forever. */
  pausedAt?: string | null;
  /** Sellers in this ZIP show a recent cluster of hard-negative outreach
   *  signals (lib/crawler/zip-saturation.ts) — blanketed by competing
   *  wholesalers. Idles at the SATURATED_CYCLE_HOURS trickle, same as
   *  opener-HOLD; a COOLING input, never a permanent exclusion. */
  saturated?: boolean;
}

/** Pure: a ZIP's crawl cost in RentCast calls/day under the tiered cadence
 *  (lib/crawler/zip-rotation recrawlCycleHours). A producing ZIP at the
 *  target 3-day rotation costs 1/3 call/day; a chewed ZIP on the weekly
 *  cycle costs 1/7; an opener-HOLD ZIP on the biweekly trickle 1/14. This
 *  is what lets the frontier EXPAND as metros get chewed: retired appetite
 *  in old metros converts directly into promotion capacity for fresh ones. */
export function zipDailyCallCost(row: FrontierZipRow, baseCycleHours = 24): number {
  const cycleH = recrawlCycleHours(
    {
      zip: row.zip,
      lastIngestedAt: row.lastIngestedAt,
      recordsIngested: row.recordsIngested30d,
      acceptRate: row.acceptRate30d,
      zeroYieldStreak: row.zeroYieldStreak ?? null,
      openerHold: row.openerHold === true,
      saturated: row.saturated === true,
    },
    baseCycleHours,
  );
  // Never cost a ZIP below the target rotation — the base cycle only marks
  // eligibility; the sustainable rotation is TARGET_CYCLE_DAYS.
  return 1 / Math.max(TARGET_CYCLE_DAYS, cycleH / 24);
}

export interface FrontierDecisions {
  /** staged rows to promote to launch, bounded by sustainable capacity. */
  promote: FrontierZipRow[];
  /** zero-yield rows proposed for retirement — REPORT/PROPOSAL grade only,
   *  never auto-applied (snapshot stats are not 30d evidence). */
  retireCandidates: Array<{ row: FrontierZipRow; reason: string }>;
  /** Paused rows whose cooldown has lapsed — revived to STAGED by the
   *  rotation pass (operator ruling 2026-07-29: ZIPs pause, never die).
   *  Staged costs zero crawl budget, so revival is auto-applied — it
   *  re-enters the promotion queue where the budget governor paces it. */
  reviveCandidates: Array<{ row: FrontierZipRow; reason: string }>;
  /** How many ZIPs the current budget sustains at the target cycle. */
  sustainableZips: number;
  eligibleNow: number;
  capacityLeft: number;
  /** Summed calls/day the current eligible set actually costs under the
   *  tiered cadence (chewed/held ZIPs cost fractions of a producing ZIP). */
  currentDailyCost: number;
  /** Eligible rows excluded because their market is paused (Memphis). */
  pausedExcluded: number;
}

/** Pure: weekly promotion + retirement-candidate pass over the registry.
 *  - Capacity = dailyBudget × TARGET_CYCLE_DAYS (a ZIP crawled every ~3
 *    days). staged rows promote oldest-created-first up to capacity.
 *  - Retirement candidates: launch/active rows that HAVE been crawled
 *    (lastIngestedAt within 30d — the belt is actually reaching them) yet
 *    show zero ingested records AND zero accept rate in the latest
 *    snapshot. Surfaced for the operator, never auto-paused. */
export function frontierDecisions(input: {
  rows: FrontierZipRow[];
  dailyBudget: number;
  now: Date;
  baseCycleHours?: number;
}): FrontierDecisions {
  const activeTiers = new Set(["launch", "active"]);
  const activeRows = input.rows.filter(
    (r) => !r.wholesaleRestricted && activeTiers.has((r.marketTier ?? "").trim()),
  );
  // Paused markets (Memphis) don't crawl — they must not hold capacity seats.
  const eligible = activeRows.filter((r) => r.pausedMarket !== true);
  const pausedExcluded = activeRows.length - eligible.length;
  const sustainableZips = Math.max(0, input.dailyBudget) * TARGET_CYCLE_DAYS;
  // Cost-weighted capacity (chew-and-move-on, 2026-07-22): the old flat
  // `sustainable − count` model priced every ZIP at a 3-day recrawl forever,
  // which froze promotion the moment the registry filled once. Under the
  // tiered cadence a chewed/held ZIP costs 1/7 to 1/14 of a producing ZIP,
  // so budget freed by chewed metros re-opens the frontier automatically.
  const baseCycleHours = input.baseCycleHours ?? 24;
  const currentDailyCost = eligible.reduce((sum, r) => sum + zipDailyCallCost(r, baseCycleHours), 0);
  const headroom = Math.max(0, input.dailyBudget) - currentDailyCost;
  const capacityLeft = Math.max(0, Math.floor(headroom * TARGET_CYCLE_DAYS));

  const staged = input.rows
    .filter((r) => !r.wholesaleRestricted && (r.marketTier ?? "").trim() === "staged")
    .filter((r) => /^\d{5}$/.test(r.zip));
  const promote = staged.slice(0, capacityLeft);

  const cutoff = input.now.getTime() - 30 * DAY_MS;
  const retireCandidates: FrontierDecisions["retireCandidates"] = [];
  for (const r of eligible) {
    if (!r.lastIngestedAt) continue; // never crawled — pacing problem, not a dead ZIP
    const t = Date.parse(r.lastIngestedAt);
    if (!Number.isFinite(t) || t < cutoff) continue; // stale stamp — belt hasn't reached it
    // Consolidation Night 2026-07-29 (item D): retirement is keyed to the
    // SUSTAINED zero-yield streak, not the one-run snapshot. The prior test
    // (recordsIngested30d===0 && acceptRate30d===0) read fields that hold
    // only the latest pass, so any ZIP whose inventory was captured on an
    // earlier pass looked "dead" — ground-truthing found 75% of flagged
    // ZIPs actively producing, including two markets in their FIRST WEEK
    // (Toledo 43607, Dayton 45402). Below_Threshold_Streak_Days increments
    // per consecutive empty run and resets on ANY yield — the same signal
    // the chewed-cadence tier already trusts (CHEWED_STREAK_RUNS).
    const streak = r.zeroYieldStreak ?? 0;
    if (streak >= RETIRE_MIN_ZERO_YIELD_STREAK) {
      retireCandidates.push({
        row: r,
        reason: `zero_yield_streak: ${streak} consecutive empty ingest runs (min ${RETIRE_MIN_ZERO_YIELD_STREAK}), last crawled within 30d`,
      });
    }
  }

  // Revival (operator ruling 2026-07-29: ZIPs pause, never die). A paused
  // row whose cooldown has lapsed goes back to STAGED — zero crawl cost,
  // ordinary promotion queue, budget-governor paced. Legacy paused rows
  // with no Paused_At stamp (paused before the field existed) revive on
  // sight rather than being stranded in the one-way door forever.
  const reviveCandidates: FrontierDecisions["reviveCandidates"] = [];
  const revivalCutoff = input.now.getTime() - REVIVAL_COOLDOWN_DAYS * DAY_MS;
  for (const r of input.rows) {
    if ((r.marketTier ?? "").trim() !== "paused") continue;
    if (!/^\d{5}$/.test(r.zip)) continue;
    if (r.wholesaleRestricted) continue;
    const pausedT = r.pausedAt ? Date.parse(r.pausedAt) : NaN;
    const cooldownLapsed = !Number.isFinite(pausedT) || pausedT <= revivalCutoff;
    if (cooldownLapsed) {
      reviveCandidates.push({
        row: r,
        reason: Number.isFinite(pausedT)
          ? `paused ${Math.floor((input.now.getTime() - pausedT) / DAY_MS)}d >= ${REVIVAL_COOLDOWN_DAYS}d cooldown`
          : "legacy pause with no Paused_At stamp — reviving rather than stranding",
      });
    }
  }

  return {
    promote,
    retireCandidates,
    reviveCandidates,
    sustainableZips,
    eligibleNow: eligible.length,
    capacityLeft,
    currentDailyCost: Math.round(currentDailyCost * 100) / 100,
    pausedExcluded,
  };
}

/** Payload shape the frontier-rotation pass writes into a frontier_retire
 *  proposal's Suggested_Action_Payload, and the one-tap Approve dispatch
 *  parses back. Returns null on anything that is not a well-formed
 *  frontier_retire action (the dispatch then refuses — fail closed). */
export function parseFrontierRetirePayload(
  raw: string | null | undefined,
): { recordId: string; zip: string } | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (p.action !== "frontier_retire") return null;
    const recordId = typeof p.recordId === "string" ? p.recordId : "";
    const zip = typeof p.zip === "string" ? p.zip : "";
    if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) return null;
    if (!/^\d{5}$/.test(zip)) return null;
    return { recordId, zip };
  } catch {
    return null;
  }
}
