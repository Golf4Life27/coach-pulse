// BUY-BOX DRIP — automated, so buyers fill their own box without the
// operator chasing them (operator ruling 2026-09-18, Spine
// recnmCDflZ43MEsDp): 79 buyers on file, 5 with a price box. Three
// deterministic, plain-ASCII touches, spaced out, that stop the moment the
// buyer fills the intake form or asks off the list.
//
// Pure. No I/O, no LLM — every string is templated and passes through
// guardBuyerCopy, the one gate every buyer-facing string in this repo goes
// through.

import { guardBuyerCopy } from "@/lib/dispo/copy-guard";
import type { BuyerRecord } from "@/types/jarvis";

export const DRIP_STEPS = 3;

/** Days that must have elapsed since the PREVIOUS step before the step at
 *  this index (0-based: index 0 gates step 1, index 1 gates step 2, ...)
 *  fires. Step 1 fires immediately (0), step 2 needs 3 days since step 1,
 *  step 3 needs 7 days since step 2. */
export const DRIP_GAP_DAYS = [0, 3, 7] as const;

const DAY_MS = 86_400_000;

/** V2 Status values that mean "never contact again" — compared
 *  case-insensitively against whatever string the mapper yields, since
 *  Status is free text on the physical table despite the narrower
 *  BuyerStatus type. */
const STATUS_DO_NOT_CONTACT: ReadonlySet<string> = new Set(["opted_out", "dead"]);

/** Buyer_Status values that mean the same thing, from the OTHER status
 *  column on the physical table (Active/Warm/Inactive/Do Not Contact) —
 *  a buyer can be excluded via either column. Compared case-insensitively. */
const BUYER_STATUS_DO_NOT_CONTACT: ReadonlySet<string> = new Set(["inactive", "do not contact"]);

/** Exported for lib/buyers/box-ack.ts (2026-09-23, Spine recgpvLksvIVzgB2h) —
 *  the box-ack gate reuses this instead of duplicating the "@" check. */
export function hasUsableEmail(email: string | null): boolean {
  return !!email && email.includes("@");
}

/** A buyer "has a box" (skip the drip) when ANY of: a max price is set, a
 *  ZIP preference is on file, or their notes carry a "BUY BOX" section
 *  (2026-09-22 bug hunt — the old check only looked at Max_Price, so buyers
 *  who already gave us ZIPs/notes but no price, e.g. Julius Florendo and
 *  Jacob Horn, kept getting re-asked for a box we already had). */
function hasBox(buyer: BuyerRecord): boolean {
  if (buyer.maxPrice != null && buyer.maxPrice !== 0) return true;
  if (buyer.targetZips && buyer.targetZips.trim().length > 0) return true;
  const notes = buyer.buyerNotes ?? buyer.notes ?? "";
  if (/buy box/i.test(notes)) return true;
  return false;
}

/** True once a buyer's own reply to the drip has already been ingested
 *  (lib/inbound/gmail-capture.ts marker `src=box_drip_reply`) — the drip
 *  must stop the moment they answer, not just on an explicit STOP
 *  (2026-09-22 bug hunt: Clarance replied 9/21 and was still scheduled for
 *  a step-2 follow-up on 9/24 because only opt-out stopped the drip). */
function hasAlreadyReplied(buyer: BuyerRecord): boolean {
  const notes = buyer.buyerNotes ?? buyer.notes ?? "";
  return notes.includes("src=box_drip_reply");
}

/** Exported for lib/buyers/box-ack.ts (2026-09-23, Spine recgpvLksvIVzgB2h) —
 *  the box-ack gate reuses this instead of duplicating the DNC/opt-out
 *  status check. */
export function isDoNotContact(buyer: BuyerRecord): boolean {
  const status = (buyer.status ?? "").trim().toLowerCase();
  const buyerStatus = (buyer.buyerStatus ?? "").trim().toLowerCase();
  return STATUS_DO_NOT_CONTACT.has(status) || BUYER_STATUS_DO_NOT_CONTACT.has(buyerStatus);
}

/** Whether `buyer` is due for its next drip step right now, and which step
 *  that is (1, 2 or 3) — null when not eligible. */
function nextStepFor(buyer: BuyerRecord, nowMs: number): 1 | 2 | 3 | null {
  if (!hasUsableEmail(buyer.email)) return null;
  if (hasBox(buyer)) return null;
  if (buyer.formCompletedAt) return null;
  if (isDoNotContact(buyer)) return null;
  if (hasAlreadyReplied(buyer)) return null;

  const step = buyer.boxDripStep ?? 0;
  if (step >= DRIP_STEPS) return null;

  const nextStep = (step + 1) as 1 | 2 | 3;
  const gapDays = DRIP_GAP_DAYS[step];
  if (gapDays === 0) return nextStep; // step 1: no prior send to gap against

  const lastAt = buyer.boxDripLastAt ? Date.parse(buyer.boxDripLastAt) : NaN;
  if (!Number.isFinite(lastAt)) return nextStep; // no usable timestamp — treat as due
  return nowMs - lastAt >= gapDays * DAY_MS ? nextStep : null;
}

/**
 * Pure. Buyers due for their next drip step right now, sorted never-dripped
 * first then oldest last-drip first, capped at `max`.
 */
export function selectDripCandidates(
  buyers: BuyerRecord[],
  nowIso: string,
  max: number,
): Array<{ buyer: BuyerRecord; step: 1 | 2 | 3 }> {
  const nowMs = Date.parse(nowIso);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  const due: Array<{ buyer: BuyerRecord; step: 1 | 2 | 3 }> = [];
  for (const buyer of buyers) {
    const step = nextStepFor(buyer, now);
    if (step) due.push({ buyer, step });
  }

  due.sort((a, b) => {
    const aDripped = (a.buyer.boxDripStep ?? 0) > 0;
    const bDripped = (b.buyer.boxDripStep ?? 0) > 0;
    if (aDripped !== bDripped) return aDripped ? 1 : -1; // never-dripped first
    if (!aDripped && !bDripped) return 0;
    const aAt = a.buyer.boxDripLastAt ? Date.parse(a.buyer.boxDripLastAt) : 0;
    const bAt = b.buyer.boxDripLastAt ? Date.parse(b.buyer.boxDripLastAt) : 0;
    return aAt - bAt; // oldest last-drip first
  });

  return due.slice(0, Math.max(0, max));
}

/** `/buyer-intake?b=<buyerId>` off the given base URL — the buyer-intake
 *  page reads `b` and passes it through to /api/buyers/intake as `buyerId`
 *  so the submit UPDATES this buyer instead of creating a duplicate. */
export function dripIntakeUrl(baseUrl: string, buyerId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/buyer-intake?b=${encodeURIComponent(buyerId)}`;
}

/** Exported (2026-09-23, Spine recgpvLksvIVzgB2h) — the box-ack email reuses
 *  this exact line instead of forking a second copy of it. */
export const STOP_LINE = "AKB Solutions LLC. Reply STOP or remove and I will take you off the list.";

/** Exported (2026-09-23, Spine recgpvLksvIVzgB2h) — box-ack.ts reuses this
 *  instead of forking a second first-name parse. */
export function firstName(name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first || "there";
}

function marketsPhrase(markets: string[] | null): string {
  return markets && markets.length > 0 ? markets.join(", ") : "your markets";
}

/**
 * Pure, deterministic — no LLM. Every returned string has already passed
 * guardBuyerCopy, so a banned phrase throws in tests instead of shipping.
 */
export function composeDripEmail(input: {
  buyerName: string | null;
  step: 1 | 2 | 3;
  markets: string[] | null;
  intakeUrl: string;
}): { subject: string; body: string } {
  const { step, intakeUrl } = input;
  const first = firstName(input.buyerName);

  let subject: string;
  let body: string;

  if (step === 1) {
    subject = "Quick question about your buy box - AKB Solutions";
    body =
      `Hi ${first},\n\n` +
      `I'm Alex with AKB Solutions. We put houses under contract in ${marketsPhrase(input.markets)} ` +
      `and assign them to cash buyers. Tell me your buy box so I only send you what fits.\n\n` +
      `${intakeUrl}\n\n` +
      `Or reply with: markets, ZIPs, max price, property types, rehab appetite.\n\n` +
      `${STOP_LINE}`;
  } else if (step === 2) {
    subject = "Following up - your buy box for AKB Solutions";
    body =
      `Hi ${first},\n\n` +
      `Still want to send you deals that fit your buy box - 60 seconds here: ${intakeUrl}\n\n` +
      `${STOP_LINE}`;
  } else {
    subject = "Last note - your buy box for AKB Solutions";
    body =
      `Hi ${first},\n\n` +
      `Last note from me. If you want deals that fit, fill this in: ${intakeUrl}\n\n` +
      `No reply and I will stop here.\n\n` +
      `${STOP_LINE}`;
  }

  return {
    subject: guardBuyerCopy(subject, "box_drip.subject"),
    body: guardBuyerCopy(body, "box_drip.body"),
  };
}
