// Tier-1 auto-acknowledgment — the system's one-time, number-free "warm hold"
// on a high-confidence INTEREST reply. @agent: crier
//
// Operator policy (2026-06-23, V1 goal): volume outreach generates volume
// inbound. A genuine "interest" reply ("yes, send proof of funds", "how soon
// can you close?") must not go cold while it waits in the operator's decision
// queue. This module sends ONE number-free acknowledgment that keeps the lead
// warm and signals a human will follow — while the existing proposal/alert
// path STILL fires, so the operator owns the actual negotiation.
//
// Advanced discussion (price, counters, acceptance) is NEVER touched here:
// the caller gates on classification === "interest", and this module refuses
// anything else. Counters/acceptances escalate to the operator untouched
// ("I'll step in for the advanced discussions").
//
// HARD GUARDS (identical posture to lib/auto-close.ts — the proven Tier-0 path):
//   0. FLAG OFF BY DEFAULT — REPLY_AUTO_ACK_LIVE must equal "true" to send.
//   1. INTEREST ONLY — never fires on counter/acceptance/rejection/unknown.
//   2. NO PRICES, NO NUMBERS — runtime assertion (isNumberFreeBody) refuses a
//      body with "$" or any 2+ digit run. The template carries neither; the
//      assertion makes drift impossible.
//   3. MAX ONE PER THREAD EVER — KV idempotency key auto_ack:<recordId>, 30d.
//   4. STANDARD SEND RAILS — quiet-hours (evaluateSendWindow), Do_Not_Text.
//   5. FULL LOGGING — every send (and every refusal) writes an audit row.
//
// Self-echoes / bot autoreplies never reach here — stripped pre-triage by
// isSelfEchoOrAutoreply, same as the Tier-0 path.

import { sendMessageWithId } from "@/lib/quo";
import { evaluateSendWindow } from "@/lib/h2-working-hours";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { audit } from "@/lib/audit-log";
import { isNumberFreeBody } from "@/lib/auto-close";

/** Approved template (operator 2026-06-23). No prices, no numbers, ever.
 *  Keeps the lead warm and signals a human follow-up; commits to no terms. */
export const AUTO_ACK_TEMPLATE =
  "Thanks for getting back — glad there's interest. Alex will follow up shortly with the details. Appreciate you. AKB Solutions.";

const AUTO_ACK_TTL_S = 30 * 24 * 3600; // 30 days — "max one per thread ever"

// ── Independent inbound vetoes (2026-07-17, the 3226 Cloverhurst lesson) ──
// The classifier said "interest" (0.9) on "It's a fast no at $156K. The
// sellers aren't interested in low ball offers." and this module cheerfully
// sent "glad there's interest". Classification is an OPINION; these vetoes
// are a fact-check this module runs on the raw inbound itself, so a
// classifier miss can never again put words of enthusiasm in the operator's
// mouth on a message that says no:
//   - NO-LANGUAGE: any negated-interest / no-shape / lowball phrasing.
//   - PRICE CONTENT: a reply carrying a number is a negotiation, and
//     negotiations get a human, never a canned template. Over-matching
//     (e.g. a year) is fine — the cost of a skipped ack is zero.
export const ACK_NO_LANGUAGE_RE =
  /\b(?:isn'?t|aren'?t|ain'?t|wasn'?t|weren'?t|not|never|no longer)\s+(?:\w+\s+)?interested\b|\bno\s+interest\b|\b(?:fast|hard|quick|firm|definite)\s+no\b|\bno\s+at\s+\$?\d|\b(?:it|that)'?s\s+a\s+(?:no|pass)\b|\blow[\s-]?ball|\bnot\s+for\s+sale\b|\bno\s+thanks?\b|\bstop\b/i;
export const ACK_PRICE_CONTENT_RE = /\$\s*\d|\b\d{1,3}[.,]?\d{3}\b|\b\d{2,4}\s*k\b/i;

export function autoAckClaimKey(recordId: string): string {
  return `auto_ack:${recordId}`;
}

/** True only when the env flag explicitly enables live auto-ack sends. */
export function autoAckLive(): boolean {
  return process.env.REPLY_AUTO_ACK_LIVE === "true";
}

/** Pure: the skip-reason for an auto-ack from the checks that need no I/O
 *  (flag, classification, template, phone, do-not-text), evaluated in order.
 *  null = those preconditions pass and the I/O guards (send window, one-per-
 *  thread KV claim) get their turn in sendAutoAck. Split out so the gate order
 *  is unit-tested without mocking the network or KV. */
export function autoAckStaticSkip(input: {
  live: boolean;
  classification: string;
  body: string;
  /** The RAW inbound that triggered this ack — fact-checked by the vetoes
   *  regardless of what the classifier concluded. */
  inboundBody: string;
  toE164: string;
  doNotText: boolean;
}): string | null {
  if (!input.live) return "not_live";
  if (input.classification !== "interest") return "not_interest";
  if (ACK_NO_LANGUAGE_RE.test(input.inboundBody)) return "inbound_contains_no_language";
  if (ACK_PRICE_CONTENT_RE.test(input.inboundBody)) return "inbound_contains_price";
  if (!isNumberFreeBody(input.body)) return "template_contains_numbers";
  if (!input.toE164) return "no_phone";
  if (input.doNotText) return "do_not_text";
  return null;
}

export interface AutoAckInput {
  recordId: string;
  toE164: string;
  state: string | null;
  doNotText: boolean;
  /** triage.classification — this module acts ONLY on "interest". */
  classification: string;
  /** The raw inbound body — the no-language / price vetoes fact-check it
   *  independently of the classification. */
  inboundBody: string;
  address?: string | null;
}

export interface AutoAckResult {
  sent: boolean;
  /** Why no send: not_live / not_interest / template_contains_numbers /
   *  no_phone / do_not_text / outside_send_window / already_acked /
   *  kv_unavailable_skip_to_avoid_double_ack / send_error. Null on success. */
  reason: string | null;
  quoMessageId: string | null;
}

/** Send the one-time, number-free interest acknowledgment. Never throws;
 *  every outcome is audited. Mirrors sendAutoClose's guard order exactly. */
export async function sendAutoAck(input: AutoAckInput): Promise<AutoAckResult> {
  const fail = async (reason: string): Promise<AutoAckResult> => {
    await audit({
      agent: "crier",
      event: "reply_auto_ack_skipped",
      status: "uncertain",
      recordId: input.recordId,
      inputSummary: { reason, classification: input.classification, address: input.address ?? null },
      outputSummary: { sent: false },
    });
    return { sent: false, reason, quoMessageId: null };
  };

  const body = AUTO_ACK_TEMPLATE;

  // Guards 0–2 + phone + do-not-text — the pure, no-I/O preconditions.
  const staticSkip = autoAckStaticSkip({
    live: autoAckLive(),
    classification: input.classification,
    body,
    inboundBody: input.inboundBody,
    toE164: input.toE164,
    doNotText: input.doNotText,
  });
  if (staticSkip) return fail(staticSkip);

  // Guard 4 — quiet-hours floor in the property's local timezone.
  const wh = evaluateSendWindow(input.state ?? null);
  if (!wh.inside) {
    return fail(`outside_send_window (local_hour=${wh.meta.local_hour} tz=${wh.meta.timezone})`);
  }

  // Guard 3 — max one per thread ever (30-day KV idempotency claim). Fail
  // CLOSED on a KV outage: an unattended send takes the safe direction rather
  // than risk a double-ack (same posture as Tier-0 auto-close).
  if (kvConfigured()) {
    let claimed = false;
    try {
      claimed = await kvProd.setNx(autoAckClaimKey(input.recordId), new Date().toISOString(), AUTO_ACK_TTL_S);
    } catch {
      return fail("kv_unavailable_skip_to_avoid_double_ack");
    }
    if (!claimed) return fail("already_acked");
  }

  try {
    const send = await sendMessageWithId(input.toE164, body);
    await audit({
      agent: "crier",
      event: "reply_auto_ack_sent",
      status: "confirmed_success",
      recordId: input.recordId,
      inputSummary: { address: input.address ?? null, to_masked: `…${input.toE164.slice(-4)}` },
      outputSummary: { sent: true, quo_message_id: send.id, body_len: body.length },
      decision: "tier_1_auto_ack_sent",
    });
    return { sent: true, reason: null, quoMessageId: send.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    await audit({
      agent: "crier",
      event: "reply_auto_ack_failed",
      status: "confirmed_failure",
      recordId: input.recordId,
      inputSummary: { address: input.address ?? null },
      outputSummary: { sent: false, error: reason },
    });
    return { sent: false, reason: `send_error: ${reason}`, quoMessageId: null };
  }
}
