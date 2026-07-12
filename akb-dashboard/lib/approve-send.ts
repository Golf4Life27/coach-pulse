// Approve-actually-sends — the /queue Approve button's dispatch rail.
// @agent: crier
//
// Wire 2 of the operator-ready punch list (phase B, operator go 2026-07-02):
// approving a jarvis_reply proposal in /queue previously only stamped
// Status=Approved — the drafted SMS never went anywhere, so the operator
// copy-pasted into Quo. This module dispatches the operator-approved (and
// optionally operator-EDITED) draft through the same rails as the proven
// auto-responders.
//
// LANE DOCTRINE: this is the OPERATOR lane. The human read the inbound, read
// (or rewrote) the draft, and clicked Approve & Send — that click is the
// authorization. So unlike auto-ack there is no env flag and no number-free
// assertion (negotiation replies legitimately carry numbers); the machine
// rails that remain are the ones that protect against MISTAKES, not judgment:
//   1. payload must be an explicit send_sms action with a phone + body
//   2. body length cap (a fat paste must not fan out as 8 segments)
//   3. Do_Not_Text — never overridable from the queue
//   4. quiet-hours floor (8-20 property-local) — TCPA is not operator-waivable
//   5. ONE dispatch per proposal ever — KV claim approve_send:<proposalId>,
//      fail-CLOSED on KV outage (double-click/two-tab protection)
//   6. every outcome audited
//
// A skipped dispatch leaves the proposal PENDING (the route must not stamp
// Approved on a no-send) so the operator can retry inside the window.

import { sendMessageWithId } from "@/lib/quo";
import { evaluateSendWindow } from "@/lib/h2-working-hours";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { audit } from "@/lib/audit-log";

/** Hard cap on an operator reply body — ~4 SMS segments. A runaway paste is a
 *  mistake, not a message. */
export const APPROVE_SEND_MAX_BODY = 640;

const APPROVE_SEND_TTL_S = 7 * 24 * 3600; // one dispatch per proposal, ever

export function approveSendClaimKey(proposalId: string): string {
  return `approve_send:${proposalId}`;
}

export interface SendSmsPayload {
  recordId: string | null;
  to: string;
  draftBody: string;
  inboundBody: string | null;
  classification: string | null;
}

/** Pure: parse a Suggested_Action_Payload and accept ONLY an explicit
 *  send_sms action with a usable phone + draft. Anything else → null (the
 *  route falls back to status-only approve). */
export function parseSendSmsPayload(actionPayload: string | null | undefined): SendSmsPayload | null {
  if (!actionPayload) return null;
  try {
    const p = JSON.parse(actionPayload) as Record<string, unknown>;
    if (p.action !== "send_sms") return null;
    const to = typeof p.to === "string" ? p.to.trim() : "";
    const draftBody = typeof p.draftBody === "string" ? p.draftBody.trim() : "";
    if (!to || !draftBody) return null;
    return {
      recordId: typeof p.recordId === "string" ? p.recordId : null,
      to,
      draftBody,
      inboundBody: typeof p.inboundBody === "string" ? p.inboundBody : null,
      classification: typeof p.classification === "string" ? p.classification : null,
    };
  } catch {
    return null;
  }
}

export interface SendEmailPayload {
  recordId: string | null;
  to: string;
  subject: string;
  draftBody: string;
  inboundBody: string | null;
  classification: string | null;
}

/** Pure: parse a Suggested_Action_Payload and accept ONLY an explicit
 *  send_email action with a usable address + subject + draft (the
 *  recommended-replies email lane, 2026-07-12). Anything else → null. */
export function parseSendEmailPayload(actionPayload: string | null | undefined): SendEmailPayload | null {
  if (!actionPayload) return null;
  try {
    const p = JSON.parse(actionPayload) as Record<string, unknown>;
    if (p.action !== "send_email") return null;
    const to = typeof p.to === "string" ? p.to.trim() : "";
    const subject = typeof p.subject === "string" ? p.subject.trim() : "";
    const draftBody = typeof p.draftBody === "string" ? p.draftBody.trim() : "";
    if (!to || !to.includes("@") || !subject || !draftBody) return null;
    return {
      recordId: typeof p.recordId === "string" ? p.recordId : null,
      to,
      subject,
      draftBody,
      inboundBody: typeof p.inboundBody === "string" ? p.inboundBody : null,
      classification: typeof p.classification === "string" ? p.classification : null,
    };
  } catch {
    return null;
  }
}

/** Pure: the no-I/O gate order. null = pass to the I/O rails. */
export function approveSendStaticSkip(input: {
  body: string;
  toE164: string;
  doNotText: boolean;
}): string | null {
  if (!input.body.trim()) return "empty_body";
  if (input.body.length > APPROVE_SEND_MAX_BODY) return "body_too_long";
  if (!input.toE164) return "no_phone";
  if (input.doNotText) return "do_not_text";
  return null;
}

export interface ApproveSendInput {
  proposalId: string;
  recordId: string;
  toE164: string;
  /** The FINAL body — operator-edited when provided, else the draft. */
  body: string;
  state: string | null;
  doNotText: boolean;
  address?: string | null;
}

export interface ApproveSendResult {
  sent: boolean;
  /** empty_body / body_too_long / no_phone / do_not_text /
   *  outside_send_window / already_dispatched /
   *  kv_unavailable_skip_to_avoid_double_send / send_error. Null on success. */
  reason: string | null;
  quoMessageId: string | null;
}

/** Dispatch the operator-approved reply. Never throws; every outcome audited.
 *  Guard order mirrors sendAutoAck (the proven path). */
export async function sendApprovedReply(input: ApproveSendInput): Promise<ApproveSendResult> {
  const fail = async (reason: string): Promise<ApproveSendResult> => {
    await audit({
      agent: "crier",
      event: "queue_approve_send_skipped",
      status: "uncertain",
      recordId: input.recordId,
      inputSummary: { reason, proposalId: input.proposalId, address: input.address ?? null },
      outputSummary: { sent: false },
    });
    return { sent: false, reason, quoMessageId: null };
  };

  const staticSkip = approveSendStaticSkip({
    body: input.body,
    toE164: input.toE164,
    doNotText: input.doNotText,
  });
  if (staticSkip) return fail(staticSkip);

  // Quiet-hours hard floor in the property's local timezone — not operator-
  // waivable from the queue (TCPA).
  const wh = evaluateSendWindow(input.state ?? null);
  if (!wh.inside) {
    return fail(`outside_send_window (local_hour=${wh.meta.local_hour} tz=${wh.meta.timezone})`);
  }

  // One dispatch per proposal ever — double-click / two-tab protection.
  // Fail CLOSED on KV outage: risking a double-text is worse than a retry.
  if (kvConfigured()) {
    let claimed = false;
    try {
      claimed = await kvProd.setNx(
        approveSendClaimKey(input.proposalId),
        new Date().toISOString(),
        APPROVE_SEND_TTL_S,
      );
    } catch {
      return fail("kv_unavailable_skip_to_avoid_double_send");
    }
    if (!claimed) return fail("already_dispatched");
  }

  try {
    const send = await sendMessageWithId(input.toE164, input.body);
    await audit({
      agent: "crier",
      event: "queue_approve_send_sent",
      status: "confirmed_success",
      recordId: input.recordId,
      externalId: send.id ?? undefined,
      inputSummary: {
        proposalId: input.proposalId,
        address: input.address ?? null,
        to_masked: `…${input.toE164.slice(-4)}`,
        body_len: input.body.length,
      },
      outputSummary: { sent: true, quo_message_id: send.id },
      decision: "operator_approved_reply_sent",
    });
    return { sent: true, reason: null, quoMessageId: send.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    await audit({
      agent: "crier",
      event: "queue_approve_send_failed",
      status: "confirmed_failure",
      recordId: input.recordId,
      inputSummary: { proposalId: input.proposalId, address: input.address ?? null },
      outputSummary: { sent: false, error: reason },
    });
    return { sent: false, reason: `send_error: ${reason}`, quoMessageId: null };
  }
}
