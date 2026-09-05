// Option-deadline tripwire (operator 2026-09-05): "$1,000 EMD per contract,
// $3,000 cap — the only way a deposit is lost is missing a termination
// deadline." This module is the PURE stage/candidate/message logic behind
// the option-tripwire cron (app/api/cron/option-tripwire/route.ts); the
// route supplies listings, sends SMS, and writes the operator action item.
//
// Calendar-day math is done in UTC on date-only components (year/month/day)
// so a deadline stamped "2026-09-10" and a run at any hour of "2026-09-05"
// both compare on the same civil-date clock — no timezone drift can push a
// deal in or out of a stage depending on when in the day the cron fires.

import type { Listing } from "@/lib/types";

export type TripwireStage = "t5" | "t2" | "lapsed";

const DAY_MS = 86_400_000;

/** Outreach statuses that mean the contract is no longer live — a lapsed
 *  option can't cost a deposit that already walked/died/closed out. */
const TERMINAL_OUTREACH_STATUSES: ReadonlySet<string> = new Set([
  "Dead",
  "Walked",
  "Terminated",
  "Closed",
  "No Response",
]);

/** Parses an ISO date/datetime string to a UTC date-only timestamp (midnight
 *  UTC of that calendar date). Returns null for anything unparseable. */
function utcDateOnlyMs(iso: string): number | null {
  const d = new Date(iso);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole calendar days from `nowIso`'s date to `deadlineIso`'s date (UTC).
 *  Positive = deadline is in the future. Null when either is unparseable. */
export function daysUntil(deadlineIso: string, nowIso: string): number | null {
  const deadline = utcDateOnlyMs(deadlineIso);
  const now = utcDateOnlyMs(nowIso);
  if (deadline === null || now === null) return null;
  return Math.round((deadline - now) / DAY_MS);
}

/** Which tripwire stage (if any) an option deadline is in right now.
 *    t5     — 3 < daysLeft ≤ 5  (a heads-up window; day 3 itself is a quiet
 *             gap between the two texts, not a missing case)
 *    t2     — 0 ≤ daysLeft ≤ 2  (decide-now window)
 *    lapsed — -14 ≤ daysLeft < 0 (deadline passed within the last two
 *             weeks; older lapses are history — Contract_Executed_At
 *             survives dead deals, and the first run must not text the
 *             operator about every stale record in the base)
 *    null   — outside all windows, or the deadline doesn't parse
 */
export const LAPSED_LOOKBACK_DAYS = 14;
export function tripwireStage(optionDeadlineIso: string | null | undefined, nowIso: string): TripwireStage | null {
  if (!optionDeadlineIso) return null;
  const daysLeft = daysUntil(optionDeadlineIso, nowIso);
  if (daysLeft === null) return null;
  if (daysLeft < 0) return daysLeft >= -LAPSED_LOOKBACK_DAYS ? "lapsed" : null;
  if (daysLeft <= 2) return "t2";
  if (daysLeft > 3 && daysLeft <= 5) return "t5";
  return null;
}

const SMS_MAX_LEN = 300;

function fmtDateUtc(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Composes the operator SMS for a tripwire stage. Leads with the decision;
 *  always stays under 300 chars (truncates a pathologically long address
 *  rather than ever growing past the cap). */
export function composeTripwireSms(listing: Listing, stage: TripwireStage, daysLeft: number): string {
  const date = listing.optionDeadline ? fmtDateUtc(listing.optionDeadline) : "unknown date";
  const address = listing.address || listing.id;

  const build = (addr: string): string => {
    switch (stage) {
      case "t5":
        return `OPTION T-5: ${addr} — offers in hand? assign / extend / terminate by ${date}`;
      case "t2":
        return `OPTION T-2: ${addr} — DECIDE: assign, extend, or TERMINATE by ${date} or the $1,000 EMD is at risk`;
      case "lapsed":
        return `OPTION LAPSED: ${addr} — deadline ${date} passed; confirm status with title TODAY`;
    }
  };

  let sms = build(address);
  if (sms.length > SMS_MAX_LEN) {
    // Trim the address down until the message fits, preferring to keep the
    // decision language (the part after the address) intact.
    const overBy = sms.length - SMS_MAX_LEN;
    const trimmedAddress = address.length > overBy + 1 ? `${address.slice(0, Math.max(0, address.length - overBy - 1))}…` : address.slice(0, 1);
    sms = build(trimmedAddress).slice(0, SMS_MAX_LEN);
  }
  return sms;
}

export interface TripwireCandidate {
  listing: Listing;
  stage: TripwireStage;
  daysLeft: number;
}

/** Listings whose option deadline sits in a live tripwire window right now:
 *  a live executed contract, a set option deadline, an outreach status that
 *  isn't terminal, and a stage the deadline math actually lands in. */
export function selectTripwireCandidates(listings: Listing[], nowIso: string): TripwireCandidate[] {
  const out: TripwireCandidate[] = [];
  for (const listing of listings) {
    if (!listing.contractExecutedAt) continue;
    if (!listing.optionDeadline) continue;
    const status = (listing.outreachStatus ?? "").trim();
    if (TERMINAL_OUTREACH_STATUSES.has(status)) continue;
    const stage = tripwireStage(listing.optionDeadline, nowIso);
    if (!stage) continue;
    const daysLeft = daysUntil(listing.optionDeadline, nowIso);
    if (daysLeft === null) continue;
    out.push({ listing, stage, daysLeft });
  }
  return out;
}

/** Idempotency / dedupe key: one fire per (record, stage) — so t5 and t2 on
 *  the same deal each fire once, but a re-run within the same stage never
 *  double-fires. */
export function tripwireKey(recordId: string, stage: TripwireStage): string {
  return `tripwire:${recordId}:${stage}`;
}
