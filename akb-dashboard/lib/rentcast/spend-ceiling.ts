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
export const RENTCAST_DAILY_CAP = (() => {
  const raw = Number(process.env.RENTCAST_24H_HARD_CEILING);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 300;
})();

/** Per UTC month. Default 1000 = the Foundation plan's included requests, so
 *  the default posture is "never knowingly enter overage". Raise this to the
 *  real plan allowance when the plan changes.
 *
 *  KNOWN IMPRECISION: this buckets by UTC CALENDAR month, while RentCast
 *  bills on its own subscription cycle (which also RESETS when the plan is
 *  changed). So the two windows drift by up to a few weeks. That is
 *  acceptable for a safety brake — it is a ceiling, not an invoice — but it
 *  means this number must never be read as "requests left this billing
 *  period". The vendor dashboard is the authority on that. */
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

export type CeilingWindow = "invocation" | "day" | "month";

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
  /** Operator-readable reason; null when allowed. */
  reason: string | null;
}

/** Pure: may one more paid call proceed? Checked cheapest-first, and the
 *  order also encodes severity — an invocation trip means a loop is running
 *  RIGHT NOW, a month trip means the bill is the problem. */
export function evaluateSpendCeiling(spent: SpendWindows, caps: SpendWindows): CeilingVerdict {
  const base = { spent, caps };
  if (spent.invocation >= caps.invocation) {
    return {
      ...base,
      allowed: false,
      blockedBy: "invocation",
      reason: `rentcast_invocation_cap — ${spent.invocation} paid calls in a single invocation ≥ cap ${caps.invocation}; a loop is running. Refusing further calls.`,
    };
  }
  if (spent.day >= caps.day) {
    return {
      ...base,
      allowed: false,
      blockedBy: "day",
      reason: `rentcast_daily_cap — ${spent.day} paid calls today ≥ cap ${caps.day} (UTC day). Refusing until the bucket rolls.`,
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

// ── KV meters ──────────────────────────────────────────────────────────

const DAY_PREFIX = "rc:spend:d:";
const MONTH_PREFIX = "rc:spend:m:";
const DAY_TTL_S = 172_800;   // 48h — outlives its own bucket
const MONTH_TTL_S = 3_456_000; // 40d — same

export function dayKey(now: Date): string {
  return `${DAY_PREFIX}${now.toISOString().slice(0, 10)}`;
}
export function monthKey(now: Date): string {
  return `${MONTH_PREFIX}${now.toISOString().slice(0, 7)}`;
}

/** Read both KV windows. Returns zeros when KV is absent — the FAIL-OPEN
 *  half of the posture; the caller audits the degradation and the
 *  in-memory window still applies. */
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
    month = Number((await kvProd.get(monthKey(now))) ?? "0") || 0;
  } catch {
    ok = false;
  }
  return { day, month, kvAvailable: ok };
}

/** Increment both KV windows by one call. Best-effort get+add+setEx, same
 *  non-atomic shape as recordFirecrawlSpend — a slight undercount is
 *  acceptable for a safety brake, and the invocation counter is exact. */
export async function recordKvSpend(now: Date = new Date()): Promise<void> {
  if (!kvConfigured()) return;
  for (const [key, ttl] of [
    [dayKey(now), DAY_TTL_S],
    [monthKey(now), MONTH_TTL_S],
  ] as const) {
    try {
      const prev = Number((await kvProd.get(key)) ?? "0") || 0;
      await kvProd.setEx(key, String(prev + 1), ttl);
    } catch {
      /* best-effort — see the fail posture note in the header */
    }
  }
}

/** The full check the choke point runs before every paid call. */
export async function checkSpendCeiling(now: Date = new Date()): Promise<CeilingVerdict & { kvAvailable: boolean }> {
  const kv = await readKvSpend(now);
  const verdict = evaluateSpendCeiling(
    { invocation: invocationSpend(), day: kv.day, month: kv.month },
    currentCaps(),
  );
  return { ...verdict, kvAvailable: kv.kvAvailable };
}
