// NO SPREAD — a listing asking at or above its own renovated value.
// @agent: appraiser
//
// Operator, 2026-08-07: "label those specific ones something different than
// 'dead' maybe just 'no spread' or something so we know it requires the price
// to change."
//
// THE FINDING behind it. Of 14 Detroit records priced through the shipped
// pricer, the 3 that SEND are worth 164-194% of their ask; the 7 that do not
// are worth 57-96% of their ask. Perfect separation. A house listed at or
// above what it is worth fully renovated cannot be wholesaled at any price,
// with any formula — and the pre-send corroboration gate already knew, flagging
// exactly these `infeasible_ask`.
//
// Intake now refuses to COLLECT them (lib/crawler/intake-filter). This module
// is the other half: the ~616 records already in Airtable were gathered under
// the old rules and still sit in the eligible pool, priced afresh every cron
// cycle, making the pipeline look four times fuller than it is.
//
// WHY NOT "Dead". Dead is a verdict about the PROPERTY and it is permanent in
// practice — nothing re-examines a dead record. This condition is a verdict
// about the PRICE, and the price is the one thing most likely to move: these
// are aged listings whose sellers have not capitulated YET. "No Spread" names
// the actual blocker, and the reviveNoSpread half of this module puts the
// record straight back in the pool the moment the ask drops below value.
//
// THE MARGIN IS DELIBERATELY ZERO (ask >= 100% of ARV). Our ARVs carry known
// error — 2302 S Randolph was understated by ~$26,000 because the seed applies
// one ZIP median $/sqft regardless of house size. A wider margin would park
// records that a corrected ARV would have priced. Only the arithmetically
// impossible gets parked.

/** The Outreach_Status value. Eligibility (lib/h2-outreach.outreachStatusEmpty)
 *  requires this field to be EMPTY, so any non-empty value removes the record
 *  from the send pool — no separate suppression list to keep in sync. */
export const NO_SPREAD_STATUS = "No Spread";

/** Statuses this backfill may overwrite. Deliberately tiny.
 *
 *  A record we have already TEXTED is in a conversation, and re-labelling it
 *  would both lie about its history and risk dropping a live negotiation. The
 *  only writable states are "never contacted" and "already parked here". */
export const WRITABLE_STATUSES: ReadonlySet<string> = new Set(["", NO_SPREAD_STATUS]);

export interface NoSpreadInput {
  /** Outreach_Status as stored (null/undefined treated as empty). */
  outreachStatus: string | null | undefined;
  listPrice: number | null | undefined;
  sqft: number | null | undefined;
  /** The ZIP's renovated $/sqft seed. Null when the ZIP is unseeded or
   *  DONT_PRICE — either way we cannot judge. */
  seedPsf: number | null | undefined;
}

export type NoSpreadAction =
  | "park"        // has spread today? no → set No Spread
  | "revive"      // parked, but the ask now sits below value → clear it
  | "leave";      // no change (already correct, unjudgeable, or not ours to touch)

export interface NoSpreadVerdict {
  action: NoSpreadAction;
  /** ARV we judged against, when we could compute one. */
  arv: number | null;
  reason: string;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Pure: what should happen to this record?
 *
 *  FAILS TO "leave" on every uncertainty — no sqft, no seed, no list price, or
 *  a status we do not own. A gate that parks records it cannot evaluate would
 *  empty the pipeline on a seed-store outage. */
export function classifyNoSpread(input: NoSpreadInput): NoSpreadVerdict {
  const status = (input.outreachStatus ?? "").trim();
  if (!WRITABLE_STATUSES.has(status)) {
    return { action: "leave", arv: null, reason: `status '${status}' is not writable (contacted or resolved)` };
  }
  if (!pos(input.listPrice)) return { action: "leave", arv: null, reason: "no list price — cannot judge" };
  if (!pos(input.sqft)) return { action: "leave", arv: null, reason: "no sqft — cannot judge" };
  if (!pos(input.seedPsf)) return { action: "leave", arv: null, reason: "no priceable ZIP seed — cannot judge" };

  const arv = Math.round(input.seedPsf * input.sqft);
  const hasSpread = input.listPrice < arv;
  const parked = status === NO_SPREAD_STATUS;

  if (!hasSpread && !parked) {
    return {
      action: "park",
      arv,
      reason: `ask $${input.listPrice.toLocaleString()} >= renovated value $${arv.toLocaleString()} — no offer exists until the price moves`,
    };
  }
  if (hasSpread && parked) {
    return {
      action: "revive",
      arv,
      reason: `ask $${input.listPrice.toLocaleString()} now below renovated value $${arv.toLocaleString()} — back in the pool`,
    };
  }
  return {
    action: "leave",
    arv,
    reason: parked ? "still no spread" : "has spread, not parked — already correct",
  };
}
