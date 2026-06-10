// Tier 0 auto-close — the system's one-time polite close on a high-
// confidence rejection. @agent: crier
//
// Operator policy (2026-06-10): Alex already sees every inbound via Quo app
// notifications. Rejection threads close WITHOUT touching him: no proposal,
// no alert, just one polite close. Negotiation judgment stays operator-only;
// this path applies EXCLUSIVELY to the zero-judgment formulaic close.
//
// HARD GUARDS (all enforced here, every send):
//   1. NO PRICES, NO NUMBERS — runtime assertion refuses any body containing
//      a "$" or a 2+ digit pattern. The approved template carries neither;
//      the assertion makes drift impossible.
//   2. MAX ONE PER THREAD EVER — KV idempotency key auto_close:<recordId>
//      with a 30-day TTL. A second rejection on the same record is a no-op.
//   3. STANDARD SEND RAILS — quiet-hours floor (evaluateSendWindow, property-
//      local 8–20, non-disableable), Do_Not_Text, and the same dispatch-claim
//      semantics every send path uses.
//   4. FULL LOGGING — every auto-send (and every refusal) writes an audit
//      row; the daily digest reads from audit, not the proposals queue.
//
// Bot autoresponders and self-echoes never reach this module — they're
// stripped pre-triage by isSelfEchoOrAutoreply (no action at all).

import { sendMessageWithId } from "@/lib/quo";
import { evaluateSendWindow } from "@/lib/h2-working-hours";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { audit } from "@/lib/audit-log";

/** Approved template (operator 2026-06-10). No prices, no numbers, ever. */
export const AUTO_CLOSE_TEMPLATE =
  "Thanks for getting back. Best of luck with the property. If anything changes, please reach out anytime. Alex, AKB Solutions.";

const AUTO_CLOSE_TTL_S = 30 * 24 * 3600; // 30 days — "max one per thread ever"

export function autoCloseClaimKey(recordId: string): string {
  return `auto_close:${recordId}`;
}

/** Pure: the no-numbers assertion. True when the body is SAFE to send.
 *  Refuses "$" anywhere and any run of 2+ digits (prices, offers, phone
 *  numbers). Single digits pass (e.g. "1 question") but the approved
 *  template has none anyway. */
export function isNumberFreeBody(body: string): boolean {
  if (!body) return false;
  if (body.includes("$")) return false;
  if (/\d{2,}/.test(body)) return false;
  return true;
}

export interface AutoCloseInput {
  recordId: string;
  toE164: string;
  state: string | null;
  doNotText: boolean;
  address?: string | null;
}

export interface AutoCloseResult {
  sent: boolean;
  /** Why no send: template_contains_numbers / do_not_text / outside_send_window
   *  / already_closed / send_error / no_phone. Null on success. */
  reason: string | null;
  quoMessageId: string | null;
}

/** Send the one-time polite close. Never throws; every outcome is audited. */
export async function sendAutoClose(input: AutoCloseInput): Promise<AutoCloseResult> {
  const fail = async (reason: string): Promise<AutoCloseResult> => {
    await audit({
      agent: "crier",
      event: "reply_auto_close_skipped",
      status: "uncertain",
      recordId: input.recordId,
      inputSummary: { reason, address: input.address ?? null },
      outputSummary: { sent: false },
    });
    return { sent: false, reason, quoMessageId: null };
  };

  // Guard 1 — the no-numbers assertion on the LIVE body (not just the
  // constant): if anyone ever edits the template into carrying a number,
  // the send refuses at runtime.
  const body = AUTO_CLOSE_TEMPLATE;
  if (!isNumberFreeBody(body)) return fail("template_contains_numbers");

  if (!input.toE164) return fail("no_phone");
  if (input.doNotText) return fail("do_not_text");

  // Guard 3 — quiet-hours floor in the property's local timezone.
  const wh = evaluateSendWindow(input.state ?? null);
  if (!wh.inside) {
    return fail(`outside_send_window (local_hour=${wh.meta.local_hour} tz=${wh.meta.timezone})`);
  }

  // Guard 2 — max one per thread ever (30-day KV idempotency claim).
  if (kvConfigured()) {
    let claimed = false;
    try {
      claimed = await kvProd.setNx(autoCloseClaimKey(input.recordId), new Date().toISOString(), AUTO_CLOSE_TTL_S);
    } catch {
      // KV down: fail CLOSED for an autonomous send — skip rather than risk
      // a double-close. (Opposite posture to the operator-triggered batch,
      // which fails open; an unattended path takes the safe direction.)
      return fail("kv_unavailable_skip_to_avoid_double_close");
    }
    if (!claimed) return fail("already_closed");
  }

  try {
    const send = await sendMessageWithId(input.toE164, body);
    await audit({
      agent: "crier",
      event: "reply_auto_close_sent",
      status: "confirmed_success",
      recordId: input.recordId,
      inputSummary: { address: input.address ?? null, to_masked: `…${input.toE164.slice(-4)}` },
      outputSummary: { sent: true, quo_message_id: send.id, body_len: body.length },
      decision: "tier_0_auto_close_sent",
    });
    return { sent: true, reason: null, quoMessageId: send.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    await audit({
      agent: "crier",
      event: "reply_auto_close_failed",
      status: "confirmed_failure",
      recordId: input.recordId,
      inputSummary: { address: input.address ?? null },
      outputSummary: { sent: false, error: reason },
    });
    return { sent: false, reason: `send_error: ${reason}`, quoMessageId: null };
  }
}
