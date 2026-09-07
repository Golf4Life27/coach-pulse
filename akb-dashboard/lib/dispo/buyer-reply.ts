// DISPO BUYER REPLY — classify an inbound reply to a dispo blast (2026-09-07).
// @agent: scout
//
// THE GAP THIS CLOSES: dispo-trigger blasts up to ~10 buyers a deterministic
// template and stamps the SEND, but nothing ever reads what a buyer sends
// BACK. A buyer answering "I'll take it at $190k" or "send me the contract"
// changed nothing on the record and paged nobody — the deal could sit inside
// its option period while the reply aged in Gmail. This module is the
// PURE half of the fix: deterministic, regex-only classification of a
// buyer's reply body into one of three buckets. No LLM in the path — same
// posture as blast-email.ts (composeDispoBlastEmail): the read side of a
// buyer-facing lane has to be as predictable and testable as the send side.
//
// Explicit decline outranks everything else (mirrors the seller-side
// classifier's rule, lib/reply-triage.ts: "explicit decline outranks
// willing to accept") — a buyer who says "no, too high" but also throws out
// a number in the same breath must never page the operator as a live one.
// After that: an explicit ask for the contract / a clear yes, OR a named
// dollar amount at or above 90% of the assignment price, is buyer_interest.
// Anything else with a question mark or a question word is buyer_question.
// Everything left over defaults to buyer_question too — NEVER buyer_pass —
// because a false "pass" goes silent (no operator alert) while a false
// "question" still gets read (notes + buyer stamp, just no ACT NOW ping).
//
// Pure. No I/O.

import { detectL3DollarAmounts } from "@/lib/outreach/l3-amount-detector";
import { normalizeSubject } from "@/lib/inbound/gmail-thread-link";

export type BuyerReplyClass = "buyer_interest" | "buyer_question" | "buyer_pass";

export interface BuyerReplyClassification {
  classification: BuyerReplyClass;
  /** Highest dollar amount named in the reply, or null. */
  amountUsd: number | null;
  /** Plain-language why, for notes/audit — not shown to the buyer, ever. */
  reason: string;
}

// Explicit decline. Checked FIRST — a decline buried next to a lowball
// number must not read as interest.
const PASS_PATTERNS: RegExp[] = [
  /\bnot interest(ed|ing)?\b/i,
  /\bno thanks?\b/i,
  /\bno,? thank you\b/i,
  /\bpass(ing)? on (this|it)\b/i,
  /^\s*pass\.?\s*$/i,
  /\bnot for (me|us)\b/i,
  /\bnot a fit\b/i,
  /\btoo (high|much|rich)\b/i,
  /\bway overpriced\b/i,
  /\bwe'?re out\b/i,
  /^\s*no\.?\s*$/i,
  /\bhard pass\b/i,
];

// Explicit ask for the contract, or a clear yes.
const INTEREST_PATTERNS: RegExp[] = [
  /\bsend (me |over )?(the )?contract\b/i,
  /\bi'?ll take it\b/i,
  /\bi want it\b/i,
  /\bwe want (this|it)\b/i,
  /\bwe'?re in\b/i,
  /\blet'?s do it\b/i,
  /\bready to (close|move|buy)\b/i,
  /\bproof of funds (attached|is attached|enclosed)\b/i,
  /\bi'?m in\b/i,
  /^\s*yes[!.]?\s*$/i,
  /\byes,? (we|i)('ll| will| want)\b/i,
];

// A question — engagement, but nothing to act on without operator judgment.
const QUESTION_PATTERNS: RegExp[] = [
  /\?/,
  /\bcan (you|i)\b/i,
  /\bwhat('s| is| are)\b/i,
  /\bhow (much|many|long)\b/i,
  /\bwhen (is|can|does)\b/i,
  /\bis (there|it|this)\b/i,
  /\bdo you have\b/i,
  /\bcould you\b/i,
];

/** Pure: highest dollar amount named in the reply, or null. */
export function highestAmountUsd(body: string): number | null {
  const { amounts } = detectL3DollarAmounts(body);
  if (amounts.length === 0) return null;
  return Math.max(...amounts.map((a) => a.amountUsd));
}

/**
 * Pure. Classify a buyer's reply to a dispo blast.
 *
 * `assignmentPrice` is the number the buyer was quoted — a named amount at
 * or above 90% of it reads as a live offer (buyer_interest); below that it
 * is a counter needing a human, not a number this module resolves, so it
 * falls to buyer_question.
 */
export function classifyBuyerReply(
  body: string,
  assignmentPrice: number | null,
): BuyerReplyClassification {
  const text = (body ?? "").trim();
  const amountUsd = text ? highestAmountUsd(text) : null;

  if (!text) {
    return { classification: "buyer_question", amountUsd: null, reason: "empty reply" };
  }

  if (PASS_PATTERNS.some((re) => re.test(text))) {
    return { classification: "buyer_pass", amountUsd, reason: "explicit decline" };
  }

  if (INTEREST_PATTERNS.some((re) => re.test(text))) {
    return { classification: "buyer_interest", amountUsd, reason: "asked for contract / said yes" };
  }

  if (amountUsd != null && typeof assignmentPrice === "number" && assignmentPrice > 0) {
    if (amountUsd >= assignmentPrice * 0.9) {
      return { classification: "buyer_interest", amountUsd, reason: "named a number ≥ 90% of assignment price" };
    }
  }

  if (QUESTION_PATTERNS.some((re) => re.test(text))) {
    return { classification: "buyer_question", amountUsd, reason: "asked a question" };
  }

  return { classification: "buyer_question", amountUsd, reason: "no clear signal — default to question, never silent" };
}

/** Pure: does this Gmail subject look like a reply to a dispo blast? Guards
 *  against a stale/reused thread id ever being read as a buyer reply when
 *  the thread has drifted onto something else. Mirrors composeDispoBlastEmail
 *  (lib/dispo/blast-email.ts), whose subject always starts "Off-market:". */
export function isDispoBlastSubject(subject: string | null | undefined): boolean {
  return /^off-market:/i.test(normalizeSubject(subject));
}

// ── Note formatting (pure — the cron does the I/O) ──────────────────────
// The listing block reuses the "[Gmail inbound msg <id> ...]" marker form
// the seller path writes (lib/inbound/gmail-capture.ts), so
// extractCitedGmailIds — the seller lane's own dedupe — recognizes a
// buyer-reply message id too without a second dedupe mechanism to keep in
// sync.

export interface BuyerReplyNoteInput {
  msgId: string;
  threadId: string;
  /** ISO date the message was sent. */
  date: string;
  buyerName: string;
  buyerEmail: string;
  classification: BuyerReplyClass;
  amountUsd: number | null;
  body: string;
  ingestedAt?: string;
}

function amountLabel(amountUsd: number | null): string {
  return amountUsd != null ? `$${Math.round(amountUsd).toLocaleString("en-US")}` : "no number";
}

/** Verbatim-body block appended to the listing's Verification_Notes —
 *  the seller-side dossier reads a buyer reply the same way it reads any
 *  other inbound email. Idempotent by msgId (see extractCitedGmailIds). */
export function formatListingReplyNoteBlock(input: BuyerReplyNoteInput): string {
  const ingestedAt = input.ingestedAt ?? new Date().toISOString();
  const mm = input.date.match(/(\d{4})-(\d{2})-(\d{2})/);
  const md = mm ? `${parseInt(mm[2], 10)}/${parseInt(mm[3], 10)}` : input.date.slice(0, 10);
  return [
    `${md} — DISPO BUYER REPLY (${input.classification}) from ${input.buyerName} <${input.buyerEmail}>: ${input.body}`,
    `[Gmail inbound msg ${input.msgId} thread=${input.threadId} ts=${input.date} src=dispo_buyer_reply ingested_at=${ingestedAt}]`,
  ].join("\n");
}

/** Structured intel line appended to the listing's Verification_Notes ONLY
 *  on buyer_interest — the operator-facing record of the live offer, next
 *  to the verbatim block above. */
export function formatBuyerInterestLine(input: {
  buyerName: string;
  buyerEmail: string;
  amountUsd: number | null;
  body: string;
  nowIso?: string;
}): string {
  const iso = input.nowIso ?? new Date().toISOString();
  const excerpt = input.body.trim().slice(0, 200);
  return `[DISPO BUYER INTEREST ${iso}] ${input.buyerName} ${input.buyerEmail} ${amountLabel(input.amountUsd)}: ${excerpt}`;
}

/** One-line note appended to the buyer's own Buyer_Notes field. */
export function formatBuyerNoteLine(input: {
  classification: BuyerReplyClass;
  amountUsd: number | null;
  address: string;
  nowIso?: string;
}): string {
  const iso = (input.nowIso ?? new Date().toISOString()).slice(0, 16).replace("T", " ");
  return `${iso} — Dispo reply (${input.classification}) on ${input.address}: ${amountLabel(input.amountUsd)}`;
}
