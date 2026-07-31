// Vision queue — the bucket for openers that HELD on a guessed rehab.
// @agent: appraiser / crier
//
// THE DEFECT (256 Westchester Dr, Birmingham AL — 2026-07-31, rec
// reckHdag4kCuTyNj1). A renovated 4/2 listed at $234,900 received an
// autonomous cash opener of $74,500. The agent's reply: "No where close,
// their bottom line is $230k."
//
// The ARV was NOT wrong. Reconstructed to the dollar:
//     ARV     = seed $/sqft × 1,902 sqft  ≈ $223,750   (~$117/sqft — right;
//                                                       agent said $230k)
//     rehab   = 0.30 × ARV                 = $67,125   ← GUESSED
//     ceiling = 0.70 × 223,750 − 67,125 − 15,000 fee
//     opener                               =  $74,500  ✓
//
// The model subtracted a $67,125 gut renovation from a house with a quartz
// waterfall island and refinished hardwoods. rough-opener-ceiling.ts:99
// applies ROUGH_REHAB_PCT_OF_ARV (0.30) whenever no vision rehab exists —
// and lowball-eligibility.ts:81 grants eligibility on DOM ≥ 60 "on
// time-on-market alone (no vision needed)". This listing sat 380 days.
//
// Two individually-defensible rules, lethal in combination:
//   1. aged listings skip the condition read;
//   2. no condition read ⇒ assume a 30%-of-ARV renovation.
// Together they guarantee an insulting offer on ANY renovated house that
// sits — and a renovated house that sits is the single most common way a
// listing reaches 380 DOM. 380 days at $234,900 means OVERPRICED, not
// distressed, and the only signal that can tell those apart is the one the
// eligibility gate skips.
//
// THE RULE: rehab is the largest term in the opener after ARV itself.
// Guessing it IS guessing the offer. An opener resting on a placeholder
// rehab must never reach a seller.
//
// WHY A SEPARATE BUCKET (operator, 2026-07-31): a held opener already
// writes an `h2_opener_hold` Agent_Proposals row, and that queue holds 533
// pending items. Dropping these in there buries them — and worse, mislabels
// them: a record that needs VISION is MACHINE work, not an operator
// decision. These carry Vision_Queue_State instead, the drain cron clears
// them autonomously, and only a vision FAILURE (no photos, call failed)
// is ever promoted to something the operator sees.
//
// Pure. No I/O. Tested in lib/pricing/vision-queue.test.ts.

/** Airtable field name + the ID, for by-id writers. */
export const VISION_QUEUE_FIELD = "Vision_Queue_State";
export const VISION_QUEUE_FIELD_ID = "fldqgrBDtoRceShP2";

export type VisionQueueState = "needs_vision" | "vision_failed" | "cleared";

/** The rough-ceiling source that means "the rehab in this number is a
 *  guess". Mirrors RoughCeilingSource in lib/rough-opener-ceiling.ts —
 *  kept as a string literal so this module stays dependency-free. */
export const PLACEHOLDER_REHAB_SOURCE = "rough_buybox_arv_placeholder_rehab";

/** Hold reason emitted by the send path so the h2 summary, the audit row
 *  and the queue router all name the same thing. */
export const PLACEHOLDER_REHAB_HOLD_REASON = "placeholder_rehab_needs_vision";

/** Pure: does this priced opener rest on a guessed rehab? */
export function restsOnPlaceholderRehab(input: {
  basis?: string | null;
  estRehab?: number | null;
  estRehabMid?: number | null;
}): boolean {
  if (input.basis === PLACEHOLDER_REHAB_SOURCE) return true;
  // Defence in depth: even if the basis string changes shape, an opener with
  // NO vision rehab on the record is by definition placeholder-priced.
  const hasVisionRehab =
    (typeof input.estRehabMid === "number" && input.estRehabMid > 0) ||
    (typeof input.estRehab === "number" && input.estRehab > 0);
  return !hasVisionRehab && input.basis != null && input.basis.startsWith("rough_buybox_arv");
}

/** Pure: is this hold MACHINE work (route to the vision queue) or an
 *  OPERATOR decision (the existing h2_opener_hold proposal)?
 *
 *  Only the placeholder-rehab hold is machine work. Every other hold —
 *  lowball floor, market not priceable, MAO lineage, over-list — is a
 *  judgement call and keeps its proposal. Getting this split wrong in the
 *  permissive direction would quietly re-bury these in the 533-item pile,
 *  so the test is an EXACT reason match, not a prefix. */
export function isMachineResolvableHold(reason: string | null | undefined): boolean {
  return reason === PLACEHOLDER_REHAB_HOLD_REASON;
}

export interface QueueRouting<T> {
  /** Machine work — gets Vision_Queue_State=needs_vision, no proposal. */
  toVisionQueue: T[];
  /** Operator decisions — keep the existing h2_opener_hold proposal path. */
  toOperatorProposals: T[];
}

/** Pure: split a run's skipped holds into the two lanes. The h2 route feeds
 *  ONLY toOperatorProposals into the proposal writer, which is what keeps
 *  the vision bucket out of the operator's decision queue. */
export function routeHolds<T extends { reason?: string | null }>(holds: T[]): QueueRouting<T> {
  const toVisionQueue: T[] = [];
  const toOperatorProposals: T[] = [];
  for (const h of holds) {
    if (isMachineResolvableHold(h.reason)) toVisionQueue.push(h);
    else toOperatorProposals.push(h);
  }
  return { toVisionQueue, toOperatorProposals };
}

/** Pure: the state a drained record lands in.
 *  A vision run that produced a usable rehab RELEASES the record (cleared —
 *  the next h2 pass prices it properly and may send). Anything else parks it
 *  in vision_failed, which IS the operator's bucket: spot-check the images
 *  or run rehab by hand. */
export function drainOutcome(
  rehabFromVision: number | null | undefined,
): Extract<VisionQueueState, "cleared" | "vision_failed"> {
  return typeof rehabFromVision === "number" && rehabFromVision > 0 ? "cleared" : "vision_failed";
}
