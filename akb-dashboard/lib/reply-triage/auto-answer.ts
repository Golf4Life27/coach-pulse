// Auto-answer — the missing middle of the operator's stated design.
// @agent: crier
//
// THE GAP (operator 2026-07-31). The design has always been: crawl → price →
// verify → classify → send offers → field replies → REPLY TO THOSE REPLIES
// WHEN CAPABLE → escalate only when too complex. What was built is
// classify → escalate. In lib/reply-triage, NINE of ten ReplyClassification
// branches return needsDecision:true, and EIGHT return `suggestedReply: null`
// as a hardcoded literal. Only `rejection` self-resolves (tier-0 auto-close)
// and only `soft_no` carries a draft — and that still lands in a Pending
// proposal. That is the code-level reason every deal reaches Alex's desk.
//
// SCOPE, NARROWED AFTER READING THE DOCTRINE (this matters — the first pass
// of this proposal named four buckets; two of them are already forbidden):
//
//   IN  seller_costs  — the answer is a POLICY, identical every time, and
//                       states no number: "everything is paid from proceeds at
//                       closing, never on top of the offer; lien/estate
//                       validity is the title company's to verify." That
//                       sentence is already written in the triage reasoning.
//                       Saying it back is not a judgement call.
//   IN  offer_format  — "they are processing the offer; deliver it their way,
//                       NUMBERS UNCHANGED." Deliverable, but ONLY off the
//                       delivery-stamped sticky number (INVARIANTS §3: the
//                       seller-facing number never drifts). No sticky → HOLD.
//
//   OUT disclosure_step — the triage says it outright: "the machine NEVER
//                       acknowledges legal disclosures for the operator;
//                       personal acknowledgment required." Automating an IABS
//                       acknowledgment would forge a personal legal act.
//   OUT appointment   — "operator owns the calendar commitment." The machine
//                       cannot commit Alex's calendar, and a confirmation it
//                       cannot keep is worse than silence.
//
// EVERY auto-answer is still a SEND: it goes through lib/outreach/send-gate
// (Do_Not_Text, number-level dedupe, thread truth) exactly like any other
// outbound. This module only decides WHETHER and composes WHAT.
//
// Pure. No I/O. Tested in lib/reply-triage/auto-answer.test.ts.

import type { ReplyClassification } from "@/lib/reply-triage";
import { detectL3DollarAmounts } from "@/lib/outreach/l3-amount-detector";

/** Master kill switch. Default OFF — an auto-answer lane must be lit
 *  deliberately, never by shipping. Mirrors H2_OUTREACH_LIVE's posture. */
export const AUTO_ANSWER_LIVE = process.env.REPLY_AUTO_ANSWER_LIVE === "true";

/** The only classifications this lane will ever answer. Deliberately a
 *  closed set: adding to it is a doctrine change, not a config change. */
export const AUTO_ANSWERABLE: ReadonlySet<ReplyClassification> = new Set<ReplyClassification>([
  "seller_costs",
  "offer_format",
]);

export type AutoAnswerRefusal =
  | "not_auto_answerable"      // classification outside the closed set
  | "amount_in_reply"          // seller named a number → it's a counter in disguise
  | "no_sticky_offer"          // offer_format with nothing sourced to restate
  | "already_answered"         // one auto-answer per thread, ever
  | "lane_dark";               // REPLY_AUTO_ANSWER_LIVE is not "true"

export interface AutoAnswerDecision {
  /** True only when a body was composed AND the lane is live. */
  send: boolean;
  /** The composed message — present even when the lane is dark, so the
   *  dry-run route can show exactly what WOULD have gone out. */
  body: string | null;
  refusal: AutoAnswerRefusal | null;
  /** Operator-readable why, for the audit row and the dry-run table. */
  detail: string;
}

export interface AutoAnswerInput {
  classification: ReplyClassification;
  /** The seller's inbound, verbatim. */
  inboundBody: string;
  /** Outreach_Offer_Price / the delivery-stamped sent number. NEVER a
   *  freshly-computed one — INVARIANTS §3. */
  stickyOfferUsd?: number | null;
  street?: string | null;
  /** True when this thread already received an auto-answer. */
  alreadyAutoAnswered?: boolean;
  /** Override for tests / the dry-run route; defaults to the env flag. */
  live?: boolean;
}

// ── Composers ────────────────────────────────────────────────────────────
// Both are deterministic string builders, not model calls. A fixed answer to
// a fixed question is auditable, reproducible, and cannot hallucinate a
// number — which is the entire reason this lane is allowed to exist.

/** Who-pays-what. States the policy; names NO dollar figure, because the
 *  answer is structural ("out of proceeds") and quoting a number here would
 *  re-open a price the sticky rule has already fixed. */
export function composeSellerCosts(opts: { street?: string | null }): string {
  const street = (opts.street ?? "").trim();
  const at = street ? ` on ${street}` : "";
  return (
    `Good question — those all come out of the seller's proceeds at closing${at}, ` +
    `not on top of my offer, so the number I gave you is what I pay. ` +
    `Liens, back taxes and any unpaid bills get settled by the title company out of the ` +
    `sale, and they'll verify what's actually owed. Nothing out of pocket for the seller. – Alex`
  );
}

/** "Email it / put it in writing / use the state form." Re-states the STICKY
 *  number and nothing else. If there is no sticky number the caller must
 *  refuse — composing one here would invent a price. */
export function composeOfferFormat(opts: { stickyOfferUsd: number; street?: string | null }): string {
  const street = (opts.street ?? "").trim();
  const at = street ? ` for ${street}` : "";
  const amount = `$${Math.round(opts.stickyOfferUsd).toLocaleString("en-US")}`;
  return (
    `Absolutely — I'll send it over in writing. To confirm, it's ${amount} cash${at}, ` +
    `as-is with no repairs or cleanout, no financing contingency, and we close on your ` +
    `timeline. What's the best email to send it to? – Alex`
  );
}

// ── The decision ─────────────────────────────────────────────────────────

/** Pure: should this reply be auto-answered, and with what?
 *
 *  Refusal order is deliberate — cheapest and most decisive first, and the
 *  AMOUNT check sits above everything else because a seller who names a
 *  number is countering, whatever else the sentence is about. "There's a
 *  water bill and a tax bill... and I need to be paid $230k" classifies as
 *  seller_costs and is emphatically not a costs question. */
export function decideAutoAnswer(input: AutoAnswerInput): AutoAnswerDecision {
  const live = input.live ?? AUTO_ANSWER_LIVE;

  if (!AUTO_ANSWERABLE.has(input.classification)) {
    return {
      send: false,
      body: null,
      refusal: "not_auto_answerable",
      detail: `${input.classification} is outside the auto-answer set — it needs the operator (disclosure_step and appointment are permanently excluded by doctrine).`,
    };
  }

  const amounts = detectL3DollarAmounts(input.inboundBody);
  if (amounts.shouldEscalate) {
    return {
      send: false,
      body: null,
      refusal: "amount_in_reply",
      detail: `Seller named a number (${amounts.amounts.map((a) => a.token).join(", ")}) — that is a counter wearing a ${input.classification} question. Escalate.`,
    };
  }

  if (input.alreadyAutoAnswered) {
    return {
      send: false,
      body: null,
      refusal: "already_answered",
      detail: "This thread already received an auto-answer — a second one is a loop, not a conversation.",
    };
  }

  let body: string;
  if (input.classification === "offer_format") {
    const sticky = input.stickyOfferUsd;
    if (typeof sticky !== "number" || !Number.isFinite(sticky) || sticky <= 0) {
      return {
        send: false,
        body: null,
        refusal: "no_sticky_offer",
        detail:
          "Agent asked for the offer in writing but no delivery-stamped number is on the record. Composing one would invent a price (INVARIANTS §3) — operator sends it.",
      };
    }
    body = composeOfferFormat({ stickyOfferUsd: sticky, street: input.street });
  } else {
    body = composeSellerCosts({ street: input.street });
  }

  if (!live) {
    return {
      send: false,
      body,
      refusal: "lane_dark",
      detail: "Composed but NOT sent — REPLY_AUTO_ANSWER_LIVE is not \"true\". This is what would have gone out.",
    };
  }

  return { send: true, body, refusal: null, detail: `Auto-answered ${input.classification}.` };
}
