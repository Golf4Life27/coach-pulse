// Reply alerting — SMS-via-Quo to the operator when a needs-decision
// proposal lands. @agent: crier
//
// THE INCIDENT (2026-06-10, 15:28 UTC): first live H2 batch fired; the
// 13235 Freeland seller replied in ~60 seconds. The reply made it to
// Outreach_Status=Response_Received and to the Notes block, but there was
// no proactive notification — Alex caught it manually and closed the
// negotiation politely. Operator directive: "A reply turned into a live
// negotiation in 60 seconds today — alerting is no longer optional."
//
// This module is the alert delivery path. The caller (lib/scan-comms's
// proposal-create loop) invokes sendReplyAlert AFTER a jarvis_reply
// proposal lands. Best-effort by design: a failed alert MUST NOT abort the
// proposal write (the queue is the durable record of truth; SMS is the
// speed-up).
//
// Destination: ALERT_PHONE env var (operator-owned, set in Vercel). When
// unset, the alert is a no-op + an audit row so the gap is observable.
//
// Quo throttle: alerts are infrequent (one per genuine inbound reply) and
// always to the operator's own number — not routed through the H2 quota.
// We call sendMessage directly; if Quo fails, the audit row carries the
// reason. Idempotency is enforced by the caller (scan-comms only fires
// once per proposal create — same dedup key that prevents duplicate
// proposals also prevents duplicate alerts).

import { sendMessage } from "@/lib/quo";
import { audit } from "@/lib/audit-log";

const DASHBOARD_BASE_URL =
  process.env.DASHBOARD_BASE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "https://coach-pulse-ten.vercel.app");

export interface ReplyAlertInput {
  recordId: string;
  address: string | null;
  agentName: string | null;
  inboundBody: string;
  classification: string;
  decisionKind?: string | null;
}

export interface ReplyAlertResult {
  sent: boolean;
  /** Why no send (e.g. "alert_phone_not_set" / "send_error"). */
  reason: string | null;
}

/** Pure: compose the SMS body. Carrier-safe; aims under 320 chars (2 SMS).
 *  Includes address, classification, inbound snippet (clipped), record link. */
export function buildReplyAlertBody(input: ReplyAlertInput): string {
  const addr = input.address ?? "unknown address";
  const agent = input.agentName ? ` (${input.agentName})` : "";
  // Clip the inbound to a single SMS segment after the static prefix; the
  // operator can read the full text on the record page if needed.
  const snippet = (input.inboundBody ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  const tag = input.classification.toUpperCase();
  const link = `${DASHBOARD_BASE_URL}/pipeline/${encodeURIComponent(input.recordId)}`;
  return `[AKB] ${tag} reply on ${addr}${agent}: "${snippet}" → ${link}`;
}

/** Best-effort SMS via Quo to ALERT_PHONE. Never throws. */
export async function sendReplyAlert(input: ReplyAlertInput): Promise<ReplyAlertResult> {
  const to = (process.env.ALERT_PHONE ?? "").trim();
  if (!to) {
    await audit({
      agent: "crier",
      event: "reply_alert_skipped",
      status: "uncertain",
      recordId: input.recordId,
      inputSummary: { reason: "ALERT_PHONE not set" },
      outputSummary: { sent: false },
    });
    return { sent: false, reason: "alert_phone_not_set" };
  }
  const body = buildReplyAlertBody(input);
  try {
    await sendMessage(to, body);
    await audit({
      agent: "crier",
      event: "reply_alert_sent",
      status: "confirmed_success",
      recordId: input.recordId,
      inputSummary: { to_masked: `${to.slice(0, 4)}…${to.slice(-4)}`, classification: input.classification, body_len: body.length },
      outputSummary: { sent: true },
    });
    return { sent: true, reason: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "crier",
      event: "reply_alert_failed",
      status: "confirmed_failure",
      recordId: input.recordId,
      inputSummary: { to_masked: `${to.slice(0, 4)}…${to.slice(-4)}` },
      outputSummary: { sent: false, error: reason.slice(0, 200) },
    });
    return { sent: false, reason: reason.slice(0, 200) };
  }
}
