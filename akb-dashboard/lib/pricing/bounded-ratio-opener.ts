// THE BOUNDED-RATIO OPENER — April's volume with tonight's guardrails.
// @agent: appraiser
//
// OPERATOR RULING 2026-08-05, superseding the "no fraction of list survives as
// a producer" ruling (recmy2Vwp1wMA1Vs8, 2026-07-06; producer path killed
// 2026-07-27) and amending INVARIANTS §2.
//
// WHAT HAPPENED. In April a blanket 65%-of-list opener went out at hundreds a
// day and pulled a ~30% agent response rate — it produced FOUR contracts. They
// did not pencil, and the conclusion drawn was "a list ratio is not accurate
// enough." The replacement, value-anchored-or-HOLD, requires ARV and rehab on
// every opener; both come from a paid API capped at ~30 ZIP scans/day. Volume
// went from hundreds/day to 3-5/day and automated contracts went to zero.
//
// THE RE-READ. Four contracts that did not pencil does not mean ratios fail —
// it means 65% was too HIGH. That is a curve, and it is tunable. But it can
// only be learned from volume: at 3 offers/day the ratio is unknowable, at 200
// it is a week's data. Killing the volume killed the experiment.
//
// WHY IT IS SAFE NOW AND WAS NOT THEN. The ratio was killed by Blackmoor —
// 0.65 × $130,000 list on a ~$40,000 house. That is a GARBAGE LIST PRICE, and
// three guards that did not exist in July now catch that class for free, with
// no API call:
//   1. the buy-box ask ceiling ($90k Rust Belt / $150k southern) rejects a
//      $130k list before an opener is ever computed;
//   2. a $/sqft band, cached per ZIP, not per property;
//   3. an absolute dollar exposure cap (the lesson of PR #188: a ratio guard
//      bounds proportion, never risk — risk is denominated in dollars).
//
// AND THE KEY RECONCILIATION: when real ARV/rehab DO exist, the opener is the
// LOWER of the ratio price and the value-anchored MAO. Better data can only
// ever make the number safer, never higher. That is what "the good parts of
// both systems" means in code — the ratio sets the FLOOR of effort, the value
// anchor sets the CEILING of price, and neither can be overridden by the other.

import { maxAskFor, MIN_ASSIGNMENT_FEE } from "@/lib/buy-box";

/** Opening bid as a share of list. Starts nearer 50-55% than the April 65%,
 *  which bought acceptances that could not be profited on. Env-tunable
 *  BECAUSE it is meant to be tuned against real acceptance data — that is the
 *  whole point of restoring volume. */
export const RATIO_DEFAULT = 0.55;

export function openerRatio(): number {
  const raw = Number(process.env.OPENER_LIST_RATIO);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : RATIO_DEFAULT;
}

/** Hard dollar ceiling on any ratio-derived opener. Above this the exposure is
 *  too large to send on a free estimate — those route to full underwriting.
 *  A proportion test cannot bound risk; this is the absolute test beside it. */
export const MAX_RATIO_OPENER_USD = (() => {
  const raw = Number(process.env.MAX_RATIO_OPENER_USD);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100_000;
})();

/** Never send an insultingly small number; below this we are wasting the
 *  agent's goodwill for a fee that cannot carry the work. */
export const MIN_RATIO_OPENER_USD = MIN_ASSIGNMENT_FEE * 3; // $15,000

export interface BoundedRatioInput {
  /** Seller's asking price. The ONLY required input — this is the point. */
  list: number | null | undefined;
  city?: string | null;
  /** Subject size, when the listing published it. */
  sqft?: number | null;
  /** Cached renovated $/sqft ceiling for the ZIP. Per-ZIP, not per-property,
   *  so it costs nothing per offer. Null = bound not applied. */
  zipPsfCeiling?: number | null;
  /** Value-anchored MAO when ARV and rehab actually exist. When present it
   *  CAPS the opener — real data may only lower the number, never raise it. */
  valueAnchoredMao?: number | null;
}

export type RatioHoldReason =
  | "no_list_price"
  | "list_above_buy_box_ceiling"
  | "below_min_opener"
  | "exceeds_absolute_exposure";

export interface BoundedRatioResult {
  opener: number | null;
  /** Which bound actually decided the number — the audit trail for why this
   *  offer is this size. */
  basis:
    | "ratio_of_list"
    | "psf_capped"
    | "value_anchored_capped"
    | "hold";
  holdReason: RatioHoldReason | null;
  /** Every bound evaluated, for the receipt. */
  bounds: {
    ratio: number;
    ratioPrice: number | null;
    psfCap: number | null;
    valueAnchoredMao: number | null;
    askCeiling: number;
  };
}

/** Round to the nearest $250, matching the value-anchored pricer's convention
 *  so seller-facing numbers look consistent across lanes. */
function round250(n: number): number {
  return Math.round(n / 250) * 250;
}

/**
 * Pure: the cheap opener. Requires ONLY a list price — no ARV, no rehab, no
 * comps, no vendor call. Every bound below is free or cached per ZIP.
 *
 * Returns opener: null with a holdReason rather than improvising when a bound
 * refuses (INVARIANTS §1 — a gate without clean inputs holds, never guesses).
 */
export function computeBoundedRatioOpener(input: BoundedRatioInput): BoundedRatioResult {
  const ratio = openerRatio();
  const askCeiling = maxAskFor(input.city);
  const bounds = {
    ratio,
    ratioPrice: null as number | null,
    psfCap: null as number | null,
    valueAnchoredMao: input.valueAnchoredMao ?? null,
    askCeiling,
  };

  const list = typeof input.list === "number" && input.list > 0 ? input.list : null;
  if (list == null) {
    return { opener: null, basis: "hold", holdReason: "no_list_price", bounds };
  }

  // GUARD 1 — the Blackmoor guard. A list price above what the metro can
  // support is a garbage anchor; refuse to take a ratio of it at all.
  if (list > askCeiling) {
    return { opener: null, basis: "hold", holdReason: "list_above_buy_box_ceiling", bounds };
  }

  let opener = list * ratio;
  bounds.ratioPrice = opener;
  let basis: BoundedRatioResult["basis"] = "ratio_of_list";

  // GUARD 2 — $/sqft sanity. Independent of list price entirely, so a bad ask
  // cannot launder itself through the ratio.
  if (typeof input.sqft === "number" && input.sqft > 0 && typeof input.zipPsfCeiling === "number" && input.zipPsfCeiling > 0) {
    const psfCap = input.sqft * input.zipPsfCeiling;
    bounds.psfCap = psfCap;
    if (psfCap < opener) {
      opener = psfCap;
      basis = "psf_capped";
    }
  }

  // GUARD 3 — real data always wins DOWNWARD. This is the reconciliation:
  // the ratio gets us sending without paid data, and the moment paid data
  // exists it can only make the number safer.
  if (typeof input.valueAnchoredMao === "number" && input.valueAnchoredMao > 0 && input.valueAnchoredMao < opener) {
    opener = input.valueAnchoredMao;
    basis = "value_anchored_capped";
  }

  opener = round250(opener);

  // GUARD 4 — absolute dollar exposure. Proportion cannot bound risk (PR #188).
  if (opener > MAX_RATIO_OPENER_USD) {
    return { opener: null, basis: "hold", holdReason: "exceeds_absolute_exposure", bounds };
  }
  if (opener < MIN_RATIO_OPENER_USD) {
    return { opener: null, basis: "hold", holdReason: "below_min_opener", bounds };
  }

  return { opener, basis, holdReason: null, bounds };
}

/** The Beard angle, appended to every opener. Costs nothing, gives the agent a
 *  second way to say yes, and is the only line in the message that can surface
 *  inventory we cannot see from any portal. An agent who passes on this listing
 *  may still have three others in a drawer. */
export function agentInventoryAsk(): string {
  return "Also — if you have anything else that needs work, or a seller who needs speed, send it my way. I buy cash and close fast.";
}
