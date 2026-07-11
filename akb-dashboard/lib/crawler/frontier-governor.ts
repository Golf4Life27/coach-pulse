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

export interface FrontierZipRow {
  recordId: string;
  zip: string;
  marketTier: string | null;
  wholesaleRestricted: boolean;
  lastIngestedAt: string | null;
  recordsIngested30d: number | null;
  acceptRate30d: number | null;
}

export interface FrontierDecisions {
  /** staged rows to promote to launch, bounded by sustainable capacity. */
  promote: FrontierZipRow[];
  /** zero-yield rows proposed for retirement — REPORT/PROPOSAL grade only,
   *  never auto-applied (snapshot stats are not 30d evidence). */
  retireCandidates: Array<{ row: FrontierZipRow; reason: string }>;
  /** How many ZIPs the current budget sustains at the target cycle. */
  sustainableZips: number;
  eligibleNow: number;
  capacityLeft: number;
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
}): FrontierDecisions {
  const activeTiers = new Set(["launch", "active"]);
  const eligible = input.rows.filter(
    (r) => !r.wholesaleRestricted && activeTiers.has((r.marketTier ?? "").trim()),
  );
  const sustainableZips = Math.max(0, input.dailyBudget) * TARGET_CYCLE_DAYS;
  const capacityLeft = Math.max(0, sustainableZips - eligible.length);

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
    const ingested = r.recordsIngested30d ?? 0;
    const accept = r.acceptRate30d ?? 0;
    if (ingested === 0 && accept === 0) {
      retireCandidates.push({
        row: r,
        reason: "zero_yield_latest_snapshot: crawled within 30d, 0 records ingested, 0% accept",
      });
    }
  }

  return {
    promote,
    retireCandidates,
    sustainableZips,
    eligibleNow: eligible.length,
    capacityLeft,
  };
}
