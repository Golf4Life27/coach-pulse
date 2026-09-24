// RentCast spend ceiling — the brake the June bleed didn't have.
// @agent: sentry
//
// THE INCIDENT (June 2026, reconstructed from RentCast payment history
// 2026-07-31): RentCast auto-charges whenever accrued overage crosses $250.
// June crossed it FOUR times — ~$1,125, roughly 18,750 requests, about 3×
// July's entire volume. Same window as the documented Firecrawl runaway
// (the */10 intake cron re-verifying the full 54-ZIP registry). Firecrawl
// got a circuit breaker out of that incident. RentCast did not.
//
// WHY THE EXISTING GUARDS WERE NOT ENOUGH:
//   · RENTCAST_24H_HARD_CEILING existed but was read in exactly ONE place —
//     the auto-underwrite-engaged cron. The reply-triggered inline path, the
//     manual buttons, the admin routes and ~20 other call sites had no
//     ceiling at all.
//   · RENTCAST_MONTHLY_CAP was enforced only on the federation / Maverick
//     source paths, never on the appraiser or underwrite paths.
//   · The failure loop-breaker (lib/rentcast/failure-loop-breaker) bounds
//     REPEATED FAILURES of one call shape. A runaway loop making SUCCESSFUL
//     calls is invisible to it — and successful calls are billed too.
//
// The fix is a FLOOR, not a redesign: this module is consulted inside
// lib/rentcast.paidFetch, the single HTTP choke point every RentCast call
// already passes through (exported 2026-07-29, Consolidation Night item B).
// One gate, all call sites, nothing to remember to wire up.
//
// THREE WINDOWS, checked cheapest-first:
//   1. per-invocation (in-memory, no I/O)  — bounds ONE runaway loop
//   2. per UTC day    (KV)                 — bounds a runaway cron
//   3. per UTC month  (KV)                 — bounds the BILL
//
// FAIL POSTURE — deliberately split:
//   · The day and month windows need KV, and FAIL OPEN when KV is missing,
//     matching the Firecrawl breaker's stated doctrine ("a monitoring outage
//     must not silently halt the pipeline"). Every degradation is audited.
//   · The per-invocation window needs NOTHING. It is pure memory, it always
//     runs, and it FAILS CLOSED. So even with KV dead, a single lambda can
//     never make more than PER_INVOCATION_CAP paid calls — which is exactly
//     the shape that burned $1,125 in June. Fail-open on the distributed
//     meter, fail-closed on the local one: an infra outage degrades the
//     ceiling, it never removes it.

import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { laneCeiling, type SpendLane } from "@/lib/spend/paid-call-lanes";
import { currentSpendLane } from "@/lib/spend/lane-context";

// ── Caps ───────────────────────────────────────────────────────────────
// Env names are the EXISTING ones (RENTCAST_24H_HARD_CEILING,
// RENTCAST_MONTHLY_CAP) so an env already set in Vercel keeps meaning what
// it meant — this module widens WHERE they are enforced, not what they say.

/** Per UTC day. Default 300.
 *
 *  DELIBERATE CHANGE FROM 150 (the value auto-underwrite-engaged used while
 *  this env governed that ONE cron). Now that it gates every call site, 150
 *  is too tight to be safe: the observed July baseline is ~120 calls/day, so
 *  a 150 ceiling would trip on an ordinary busy day and silently starve ARV
 *  runs. 300 sits ~2.5× over baseline — invisible in normal operation — while
 *  still catching a runaway, which reaches 300 within its first hour (the
 *  Jul 28 spike did ~1,740 in a day).
 *
 *  Side effect, stated plainly: auto-underwrite-engaged's own ceiling reads
 *  the same env and therefore loosens 150 → 300. That is the intended
 *  consolidation — one number for "RentCast calls per day", not two. */
export const RENTCAST_HARD_CEILING = (() => {
  const raw = Number(process.env.RENTCAST_24H_HARD_CEILING);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 300;
})();

/** THE THROTTLE (operator word 2026-09-05: "Throttle rentcast, we should be
 *  able to use Cowork to do most of its job"). Per UTC day. Default 80.
 *
 *  Why a second knob instead of lowering the hard ceiling: the hard ceiling
 *  is a RUNAWAY BRAKE and may already be pinned high in the Vercel env; a
 *  code default cannot override an env that is set. The throttle is the
 *  OPERATING level and always applies — the effective daily cap is the
 *  smaller of the two, so neither knob can silently loosen the other.
 *
 *  Sizing history:
 *
 *  · 2026-09-05, default 80: burn was ~295/day against 3,820 calls left and
 *    26 days to the plan reset — exhaustion around 9/18. 80/day × 26 days =
 *    2,080, inside the remaining allowance with room for a bad day. The
 *    automated job shrank to rent estimates, subject facts and discovery,
 *    with comps and rehab coming from the operator's Cowork pass and ATTOM.
 *
 *  · 2026-09-22, default 80 → 200 (operator ruling, and the plan DID change
 *    — the note below about raising only alongside a plan change is
 *    satisfied, not ignored). The vendor dashboard showed 315 requests of
 *    5,000 used at day 11 of 30, so the subscription runs ~09-11 → ~10-11
 *    with 4,685 calls left over 19 days = ~246/day safely available.
 *    200 × 19 = 3,800, landing at ~4,115 of 5,000 with ~885 in reserve;
 *    observed burn is ~71/day, so this is headroom rather than a spend
 *    commitment. The sweep lane's 25% share moves 20 → 50/day.
 *
 *    What forced it: ATTOM began returning 401 on every call on 09-21, so
 *    RentCast is the ONLY comp path left, and an 80/day throttle sized for a
 *    nearly-exhausted plan was starving it while 94% of a paid plan sat
 *    unused. Eleven Counter Received rows were reading "blind" as a direct
 *    result. Revisit at the 10-11 reset. */
export const RENTCAST_DAILY_THROTTLE = (() => {
  const raw = Number(process.env.RENTCAST_DAILY_THROTTLE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
})();

/** Effective per-day cap = min(hard ceiling, throttle). */
export const RENTCAST_DAILY_CAP = Math.min(RENTCAST_HARD_CEILING, RENTCAST_DAILY_THROTTLE);

/** Per BILLING PERIOD (see RENTCAST_BILLING_ANCHOR_DAY below). Default 1000
 *  = the Foundation plan's included requests, so the default posture is
 *  "never knowingly enter overage". Raise this to the real plan allowance
 *  when the plan changes.
 *
 *  FIXED 2026-09-24 (three false "RentCast is spent" reports to the
 *  operator): this used to bucket by UTC CALENDAR month while RentCast
 *  bills on its own cycle, which the vendor dashboard showed running
 *  ~11th → ~11th ("day 11 of 30" on 2026-09-22, 315/5,000 used). A
 *  calendar-month bucket started fresh on the 1st, so by late month it held
 *  roughly a full extra plan's worth of stale calls on top of the real
 *  in-cycle count — the KV counter read ~2,333 for "2026-09" against a
 *  vendor total of 315, and every reader of that number (Pulse's vendor
 *  health tile, the maverick briefing) reported RentCast as nearly
 *  exhausted with an "Oct 1" reset that was never the real reset date
 *  either. The key is now anchored on the vendor's actual cycle start
 *  (day 11 of each month; see billingPeriodStart) instead of the calendar
 *  month. */
export const RENTCAST_MONTHLY_CAP = (() => {
  const raw = Number(process.env.RENTCAST_MONTHLY_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1000;
})();

/** Per lambda invocation. Default 60 — comfortably above the biggest honest
 *  batch (auto-underwrite-engaged runs limit=4 × ~5 calls = 20) and far below
 *  a runaway. This is the KV-independent backstop. */
export const RENTCAST_PER_INVOCATION_CAP = (() => {
  const raw = Number(process.env.RENTCAST_PER_INVOCATION_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60;
})();

export type CeilingWindow = "invocation" | "day" | "month" | "freeze";

/** OPERATOR FREEZE (2026-09-07, Spine recxIki2g0rSXS8xD). Operator, verbatim:
 *  "First order of business is to stop any rentcast calls...not raise the
 *  limit! I am over budget and overages are super expensive. It resets in
 *  4-5 days." Every paid RentCast call is refused until this instant, for
 *  every lane including "live" — a human button press is not an exception.
 *  Defaults to a date safely past the reset so a redeploy cannot silently
 *  re-enable spend; RENTCAST_FREEZE_UNTIL (ISO) moves it, and an unparseable
 *  or past value lifts the freeze. Re-arm by setting it forward again. */
export const RENTCAST_FREEZE_UNTIL: Date = (() => {
  const raw = process.env.RENTCAST_FREEZE_UNTIL;
  if (raw === undefined) return new Date("2026-09-13T00:00:00Z");
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : new Date(0);
})();

/** Pure: is the operator freeze in force at `now`? */
export function isRentcastFrozen(now: Date = new Date(), until: Date = RENTCAST_FREEZE_UNTIL): boolean {
  return now.getTime() < until.getTime();
}

export interface SpendWindows {
  invocation: number;
  day: number;
  month: number;
}

export interface CeilingVerdict {
  allowed: boolean;
  /** Which window refused, or null when the call may proceed. */
  blockedBy: CeilingWindow | null;
  spent: SpendWindows;
  caps: SpendWindows;
  /** The work class making the call (lib/spend/lane-context). */
  lane: SpendLane;
  /** The share of caps.day this lane may consume before yielding — the full
   *  cap for "live", a fraction for everything else (LANE_BUDGET_FRACTION). */
  laneDayCap: number;
  /** Operator-readable reason; null when allowed. */
  reason: string | null;
}

/** Pure: may one more paid call proceed? Checked cheapest-first, and the
 *  order also encodes severity — an invocation trip means a loop is running
 *  RIGHT NOW, a month trip means the bill is the problem.
 *
 *  LANE PRIORITY on the day window (2026-09-05 throttle): sweeps yield at 25%
 *  of the day cap, batch at 50%, discovery at 75%, live at 100% — so once the
 *  morning sweeps have spent their share the remaining calls are reserved for
 *  a seller who replied. `lane` defaults to "live" so a caller that does not
 *  know its lane gets the plain cap (existing behaviour); the choke point
 *  passes the real lane from the request context. */
export function evaluateSpendCeiling(
  spent: SpendWindows,
  caps: SpendWindows,
  lane: SpendLane = "live",
): CeilingVerdict {
  const laneDayCap = laneCeiling(lane, caps.day);
  const base = { spent, caps, lane, laneDayCap };
  if (spent.invocation >= caps.invocation) {
    return {
      ...base,
      allowed: false,
      blockedBy: "invocation",
      reason: `rentcast_invocation_cap — ${spent.invocation} paid calls in a single invocation ≥ cap ${caps.invocation}; a loop is running. Refusing further calls.`,
    };
  }
  if (spent.day >= laneDayCap) {
    return {
      ...base,
      allowed: false,
      blockedBy: "day",
      reason: `rentcast_daily_cap — ${spent.day} paid calls today ≥ ${lane} lane share ${laneDayCap} of day cap ${caps.day} (UTC day). Refusing until the bucket rolls; live work keeps the full cap.`,
    };
  }
  if (spent.month >= caps.month) {
    return {
      ...base,
      allowed: false,
      blockedBy: "month",
      reason: `rentcast_monthly_cap — ${spent.month} paid calls this month ≥ cap ${caps.month}. Every further call is billed overage. Raise RENTCAST_MONTHLY_CAP only alongside the actual plan.`,
    };
  }
  return { ...base, allowed: true, blockedBy: null, reason: null };
}

export function currentCaps(): SpendWindows {
  return {
    invocation: RENTCAST_PER_INVOCATION_CAP,
    day: RENTCAST_DAILY_CAP,
    month: RENTCAST_MONTHLY_CAP,
  };
}

// ── The in-memory (KV-independent) counter ─────────────────────────────
// Module-level state. In serverless each invocation gets a fresh module
// instance, so this counts calls within ONE lambda — precisely the runaway
// this is meant to stop. It needs no infrastructure and therefore cannot be
// disabled by an outage.

let invocationCount = 0;

export function invocationSpend(): number {
  return invocationCount;
}

export function noteInvocationCall(): void {
  invocationCount += 1;
}

/** Test-only: reset the module counter between cases. */
export function __resetInvocationCounter(): void {
  invocationCount = 0;
}

// ── Billing period (fixed 2026-09-24 — see RENTCAST_MONTHLY_CAP above) ──
// RentCast's own dashboard runs the plan ~11th → ~11th, not calendar-month.
// The period key is anchored on this day instead of the 1st.

/** The vendor's cycle-start day of month, per the 2026-09-22 dashboard read
 *  ("day 11 of 30", 315/5,000 used). Moves only if the vendor's own cycle
 *  moves (it also resets when the plan itself is changed, per the existing
 *  KNOWN IMPRECISION note above — this anchor is still a best approximation,
 *  not the invoice). */
export const RENTCAST_BILLING_ANCHOR_DAY = 11;

/** Pure: the most recent billing-anchor date (RENTCAST_BILLING_ANCHOR_DAY,
 *  UTC) on or before `now`, as "YYYY-MM-DD". This is the start of the
 *  billing period `now` falls in. */
export function billingPeriodStart(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const periodStart =
    d >= RENTCAST_BILLING_ANCHOR_DAY
      ? new Date(Date.UTC(y, m, RENTCAST_BILLING_ANCHOR_DAY))
      : new Date(Date.UTC(y, m - 1, RENTCAST_BILLING_ANCHOR_DAY));
  return periodStart.toISOString().slice(0, 10);
}

/** Pure: the NEXT billing-anchor date after the period `now` falls in —
 *  i.e. when the current period rolls. Any operator-facing "reset date"
 *  must come from here, never from "the 1st of next month". */
export function nextBillingPeriodStart(now: Date): string {
  const [y, m] = billingPeriodStart(now).split("-").map(Number); // m is 1-indexed
  return new Date(Date.UTC(y, m, RENTCAST_BILLING_ANCHOR_DAY)).toISOString().slice(0, 10);
}

// ── KV meters ──────────────────────────────────────────────────────────

const DAY_PREFIX = "rc:spend:d:";
const PERIOD_PREFIX = "rc:spend:p:";
const DAY_TTL_S = 172_800;   // 48h — outlives its own bucket
const PERIOD_TTL_S = 3_456_000; // 40d — same

export function dayKey(now: Date): string {
  return `${DAY_PREFIX}${now.toISOString().slice(0, 10)}`;
}
export function periodKey(now: Date): string {
  return `${PERIOD_PREFIX}${billingPeriodStart(now)}`;
}

/** Read both KV windows. Returns zeros when KV is absent — the FAIL-OPEN
 *  half of the posture; the caller audits the degradation and the
 *  in-memory window still applies.
 *
 *  NO MIGRATION (2026-09-24): the old calendar-month counter (rc:spend:m:*)
 *  is abandoned, not ported — this period counter starts from zero on
 *  deploy. That is acceptable because the daily throttle (200/day, hard
 *  ceiling 300) already keeps real usage far under the vendor's 5,000/cycle
 *  plan; a month counter that starts at zero mid-cycle can only ever be an
 *  UNDERcount relative to real vendor usage, never the overcount that broke
 *  trust here. */
export async function readKvSpend(now: Date = new Date()): Promise<{ day: number; month: number; kvAvailable: boolean }> {
  if (!kvConfigured()) return { day: 0, month: 0, kvAvailable: false };
  let day = 0;
  let month = 0;
  let ok = true;
  try {
    day = Number((await kvProd.get(dayKey(now))) ?? "0") || 0;
  } catch {
    ok = false;
  }
  try {
    month = Number((await kvProd.get(periodKey(now))) ?? "0") || 0;
  } catch {
    ok = false;
  }
  return { day, month, kvAvailable: ok };
}

/** Increment both KV windows by one call — ATOMICALLY (fixed 2026-08-04).
 *
 *  WAS: get → add → setEx in application space, documented as "a slight
 *  undercount is acceptable for a safety brake." It is not slight, and an
 *  undercounting brake is the one failure mode a spend ceiling cannot have.
 *  Every overlapping lambda that read the same `prev` wrote the same `prev+1`,
 *  so N concurrent calls recorded ONE. This system runs 13 outreach slots, a
 *  10-minute intake and a 30-minute backfill that routinely overlap, plus
 *  per-record appraiser legs — collisions are the normal case, not the edge.
 *
 *  OBSERVED 2026-08-04: the month meter read ~27 calls used while the audit
 *  log showed 63-106 RentCast calls in a SINGLE day. The ceiling therefore
 *  never tripped (zero HTTP-598 rows all day) — the brake was reading roughly
 *  an order of magnitude low against a 1,000-call plan, which is the same
 *  shape as the June overage ($1,470 in auto-charges).
 *
 *  INCRBY is atomic server-side, so concurrent callers each get their own
 *  increment. TTL is attached only on the first write of a period (INCRBY
 *  creates a key with no expiry); a later EXPIRE would reset the window and
 *  is deliberately not issued. */
export async function recordKvSpend(now: Date = new Date()): Promise<void> {
  if (!kvConfigured()) return;
  for (const [key, ttl] of [
    [dayKey(now), DAY_TTL_S],
    [periodKey(now), PERIOD_TTL_S],
  ] as const) {
    try {
      const total = await kvProd.incrBy(key, 1);
      if (total === 1) await kvProd.expire(key, ttl);
    } catch {
      /* best-effort — see the fail posture note in the header */
    }
  }
}

/** The full check the choke point runs before every paid call. */
export async function checkSpendCeiling(now: Date = new Date()): Promise<CeilingVerdict & { kvAvailable: boolean }> {
  // Operator freeze outranks every window and never touches KV: a refused
  // call must cost nothing, not even a meter read.
  if (isRentcastFrozen(now)) {
    return {
      allowed: false,
      blockedBy: "freeze",
      spent: { invocation: invocationSpend(), day: -1, month: -1 },
      caps: currentCaps(),
      lane: currentSpendLane(),
      laneDayCap: 0,
      reason: `rentcast_frozen_by_operator until ${RENTCAST_FREEZE_UNTIL.toISOString()} (operator 2026-09-07: over budget, overages expensive — no paid RentCast calls from any lane)`,
      kvAvailable: true,
    };
  }
  const kv = await readKvSpend(now);
  const verdict = evaluateSpendCeiling(
    { invocation: invocationSpend(), day: kv.day, month: kv.month },
    currentCaps(),
    currentSpendLane(),
  );
  return { ...verdict, kvAvailable: kv.kvAvailable };
}
