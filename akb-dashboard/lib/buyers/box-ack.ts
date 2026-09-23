// BUY-BOX ACK — the revised auto-reply the operator approved 2026-09-23
// (Spine recgpvLksvIVzgB2h, verbatim: "yes on the revised auto reply").
// @agent: scout
//
// SCOPE (exactly what was approved, nothing broader): in the same run that
// ingests a genuine (non-opt-out, non-bounce) buy-box drip reply —
// app/api/cron/dispo-buyer-replies, the drip loop —
//   - a reply that CAPTURED a box (this run's captureBuyBoxFromReply wrote
//     ZIPs or a Max_Price to the record) gets ONE templated thank-you email,
//     threaded on the drip thread, once per buyer ever.
//   - every other genuine reply (no box captured — e.g. a buying-pause or a
//     referral pitch, which is not a buy box) gets an operator card on the
//     Maverick home queue instead. No send.
// This supersedes, for this one message type only, the "never sends
// anything to a buyer" note that used to sit at the top of
// lib/dispo/buyer-reply.ts — see that file's header for the pointer back
// here.
//
// Pure. No I/O. shouldSendBoxAck is the one gate every call site in the
// route runs through before a send is even considered; composeBoxAckEmail
// is templated copy, no LLM, passed through guardBuyerCopy exactly like
// composeDripEmail (lib/buyers/box-drip.ts). buildBoxAckCard shapes the
// operator-queue card; the route does the actual KV write via
// lib/maverick/operator-actions.upsertOperatorActions.

import { guardBuyerCopy } from "@/lib/dispo/copy-guard";
import { STOP_LINE, firstName } from "@/lib/buyers/box-drip";
import type { OperatorAction } from "@/lib/maverick/operator-actions";

// ── Send gate ────────────────────────────────────────────────────────────

export interface BoxAckGateInput {
  /** True when THIS RUN's captureBuyBoxFromReply wrote a ZIP list or a
   *  Max_Price to the buyer record (i.e. the field was empty and the reply
   *  filled it) — never true for a reply that merely repeats a box already
   *  on file. */
  boxCaptured: boolean;
  /** True when Buyer_Notes already carries a `[box_ack_sent ` marker — once
   *  per buyer, ever, regardless of how many more boxes they send later. */
  alreadyAcked: boolean;
  /** Do Not Contact / opted out, from lib/buyers/box-drip.isDoNotContact
   *  (plus this run's own opt-out, if the same batch also opted the buyer
   *  out) — reused rather than duplicated per the operator's scope. */
  doNotContact: boolean;
  /** lib/buyers/box-drip.hasUsableEmail(buyer.email) — reused, not
   *  duplicated. */
  hasUsableEmail: boolean;
  /** BUYER_AUTO_REPLY_DISABLE === "1", read by the caller — this module
   *  never touches process.env itself, so the env value can never leak into
   *  a log or response through here. */
  killSwitchOn: boolean;
  /** This run's send cap already reached (30/run) — checked by the caller
   *  as sends are counted, so this gate stays pure and stateless per call. */
  capReached: boolean;
}

export type BoxAckDecision =
  | { action: "send" }
  | { action: "card" }
  | { action: "skip"; reason: string };

/**
 * Pure. Per-buyer routing for a genuine drip reply this run. DNC/opted-out
 * is checked FIRST and blocks BOTH outcomes — the operator ruling is
 * explicit that neither a send nor a card happens for a Do Not Contact
 * buyer, even one whose reply happened to capture a box or whose reply
 * arrived on a thread despite an out-of-band opt-out. Past that gate: no
 * box captured always means a card (never gated by the kill switch, the
 * once-ever marker, email, or the send cap — a card never sends anything);
 * a captured box sends a thank-you, subject to the remaining send-only
 * gates.
 */
export function shouldSendBoxAck(input: BoxAckGateInput): BoxAckDecision {
  if (input.doNotContact) return { action: "skip", reason: "do_not_contact" };
  if (!input.boxCaptured) return { action: "card" };
  if (input.killSwitchOn) return { action: "skip", reason: "kill_switch" };
  if (input.alreadyAcked) return { action: "skip", reason: "already_acked" };
  if (!input.hasUsableEmail) return { action: "skip", reason: "no_email" };
  if (input.capReached) return { action: "skip", reason: "cap_reached" };
  return { action: "send" };
}

// ── Copy (templated, no LLM) ─────────────────────────────────────────────

/**
 * Pure, deterministic. Subject is "Re: " + the drip thread's own original
 * subject (the earliest message on the thread — our own first send), so a
 * reply threads visually regardless of which of the 3 drip steps the buyer
 * actually answered. Body is fixed operator-approved copy: no deal content,
 * no addresses, no prices, no digits. Both pass guardBuyerCopy — a banned
 * phrase throws under test rather than shipping.
 */
export function composeBoxAckEmail(input: {
  buyerName: string | null;
  /** The drip thread's original (earliest-message) subject, or null when it
   *  can't be read — falls back to a generic subject rather than blocking
   *  the send. */
  originalSubject: string | null;
}): { subject: string; body: string } {
  const first = firstName(input.buyerName);
  const baseSubject = (input.originalSubject ?? "").trim() || "your buy box";
  const subject = guardBuyerCopy(`Re: ${baseSubject}`, "box_ack.subject");
  const body = guardBuyerCopy(
    `Hi ${first},\n\n` +
      `Thanks for sending over your buy box. I have it on file and will only send you deals that fit it.\n\n` +
      `Alex\n` +
      `AKB Solutions\n\n` +
      `${STOP_LINE}`,
    "box_ack.body",
  );
  return { subject, body };
}

// ── Operator card (no send) ──────────────────────────────────────────────

const CARD_EXPIRES_DAYS = 14;
const REPLY_EXCERPT_CHARS = 300;

/** `https://mail.google.com/mail/u/0/#all/<threadId>` — the standard Gmail
 *  web-UI deep link into a thread by id. Null input yields null, never a
 *  malformed link. */
export function gmailThreadLink(threadId: string | null): string | null {
  return threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;
}

export interface BoxAckCardInput {
  buyerId: string;
  buyerName: string | null;
  /** The genuine reply's raw body — excerpted to REPLY_EXCERPT_CHARS, never
   *  shown to the buyer, operator-facing only. */
  replyBody: string;
  threadId: string | null;
  nowIso: string;
}

/** Pure: `buyer-drip-reply-<buyerId>` operator-queue card for a drip reply
 *  that did NOT capture a box. No send action on this card — the operator
 *  reads it and decides what, if anything, to say back. */
export function buildBoxAckCard(input: BoxAckCardInput): OperatorAction {
  const excerpt = input.replyBody.trim().slice(0, REPLY_EXCERPT_CHARS);
  const link = gmailThreadLink(input.threadId);
  const why = link ? `${excerpt}\n\n${link}` : excerpt;
  const postedAt = input.nowIso;
  const expiresAt = new Date(Date.parse(postedAt) + CARD_EXPIRES_DAYS * 86_400_000).toISOString();
  return {
    id: `buyer-drip-reply-${input.buyerId}`,
    title: `Buyer replied to buy-box email: ${input.buyerName?.trim() || "buyer"}`,
    why,
    instructions: null,
    href: link,
    revenueUsd: null,
    deadlineAt: null,
    expiresAt,
    postedAt,
    postedBy: "scout",
  };
}
