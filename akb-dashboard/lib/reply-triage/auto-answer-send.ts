// Auto-answer send path. @agent: crier
//
// The I/O half of lib/reply-triage/auto-answer (the decision half is pure).
// Deliberately a near-mirror of lib/auto-ack.sendAutoAck — same guard order,
// same choke point, same fail-closed KV posture — because that lane has
// already survived review and a second shape would be a second set of bugs.
//
// GUARD ORDER (cheapest and most decisive first):
//   0. decideAutoAnswer  — closed classification set, amount veto, sticky-
//                          number requirement, dark-flag. Pure, no I/O.
//   1. phone + Do_Not_Text
//   2. quiet hours in the PROPERTY's local timezone
//   3. one auto-answer per record, ever (KV claim, fails CLOSED)
//   4. lib/outreach/send-gate — the floor every outbound crosses
//
// Purpose is "reply": this is a live conversation, so the renovated-opener
// veto correctly does not apply (refusing to answer someone who is talking to
// us is its own harm — send-gate header, 2026-07-26).

import { audit } from "@/lib/audit-log";
import { sendGuarded } from "@/lib/outreach/send-gate";
import { evaluateSendWindow } from "@/lib/h2-working-hours";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { decideAutoAnswer, type AutoAnswerDecision } from "./auto-answer";
import type { ReplyClassification } from "@/lib/reply-triage";

/** One auto-answer per record, held for 30 days. */
const CLAIM_TTL_S = 30 * 86_400;
const claimKey = (recordId: string) => `reply:autoanswer:${recordId}`;

export interface AutoAnswerSendInput {
  recordId: string;
  toE164: string;
  classification: ReplyClassification;
  inboundBody: string;
  state: string | null;
  doNotText: boolean;
  address: string | null;
  /** Delivery-stamped sticky number. NEVER a fresh computation. */
  stickyOfferUsd: number | null;
}

export interface AutoAnswerSendResult {
  sent: boolean;
  reason: string | null;
  quoMessageId: string | null;
  /** The composed body — present even on a skip, so the caller can attach it
   *  to the operator proposal instead of throwing the work away. */
  body: string | null;
  decision: AutoAnswerDecision;
}

export async function sendAutoAnswer(input: AutoAnswerSendInput): Promise<AutoAnswerSendResult> {
  const decision = decideAutoAnswer({
    classification: input.classification,
    inboundBody: input.inboundBody,
    stickyOfferUsd: input.stickyOfferUsd,
    street: input.address,
  });

  const skip = async (reason: string): Promise<AutoAnswerSendResult> => {
    await audit({
      agent: "crier",
      event: "reply_auto_answer_skipped",
      status: "uncertain",
      recordId: input.recordId,
      inputSummary: { reason, classification: input.classification, address: input.address },
      outputSummary: { sent: false, composed: decision.body != null },
    }).catch(() => {});
    return { sent: false, reason, quoMessageId: null, body: decision.body, decision };
  };

  // 0 — the pure decision (includes the dark-flag check).
  if (!decision.send) return skip(decision.refusal ?? "declined");
  // 1 — phone + explicit do-not-text.
  if (!input.toE164) return skip("no_phone");
  if (input.doNotText) return skip("do_not_text");
  // 2 — quiet hours where the PROPERTY is, not where the server is.
  const wh = evaluateSendWindow(input.state);
  if (!wh.inside) {
    return skip(`outside_send_window (local_hour=${wh.meta.local_hour} tz=${wh.meta.timezone})`);
  }
  // 3 — one per record, ever. FAIL CLOSED on a KV outage: an unattended send
  // takes the safe direction rather than risk answering the same thread twice.
  if (kvConfigured()) {
    let claimed = false;
    try {
      claimed = await kvProd.setNx(claimKey(input.recordId), new Date().toISOString(), CLAIM_TTL_S);
    } catch {
      return skip("kv_unavailable_skip_to_avoid_double_answer");
    }
    if (!claimed) return skip("already_answered");
  }

  try {
    // 4 — the floor. Number-level dedupe, Do_Not_Text, thread truth.
    const gated = await sendGuarded({
      to: input.toE164,
      body: decision.body!,
      purpose: "reply",
      recordId: input.recordId,
      listing: { doNotText: input.doNotText },
      auditContext: { lane: "auto_answer", address: input.address },
    });
    if (!gated.sent) return skip(`send_gate_refused: ${gated.reason}`);
    const send = gated.result!;
    await audit({
      agent: "crier",
      event: "reply_auto_answer_sent",
      status: "confirmed_success",
      recordId: input.recordId,
      inputSummary: {
        classification: input.classification,
        address: input.address,
        to_masked: `…${input.toE164.slice(-4)}`,
      },
      outputSummary: { sent: true, quo_message_id: send.id, body_len: decision.body!.length },
      decision: `auto_answer_${input.classification}`,
    });
    return { sent: true, reason: null, quoMessageId: send.id, body: decision.body, decision };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    await audit({
      agent: "crier",
      event: "reply_auto_answer_failed",
      status: "confirmed_failure",
      recordId: input.recordId,
      inputSummary: { address: input.address },
      outputSummary: { sent: false, error: reason },
    }).catch(() => {});
    return { sent: false, reason: `send_error: ${reason}`, quoMessageId: null, body: decision.body, decision };
  }
}
