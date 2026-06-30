// ZIP approval SMS dispatch (Workstream D1, item 5).
// @agent: scout
//
// Notifies the operator that a ZIP has entered approval_pending and asks
// for a YES/NO reply. Fires in-code at the moment of a state flip; the
// zip-approval-reply-scan cron also calls this as a backstop for ZIPs
// that entered approval_pending out-of-band (manual edit, future D3
// expansion proposals). Idempotent per ZIP — skips when the row already
// has the "sms" channel recorded.
//
// Operator cell reuses MAVERICK_STAGE4_SMS_TARGET (same destination Maverick
// Tier-3 escalations go to) — Alex's personal cell +16302172539
// (operator-confirmed 2026-06-30), NOT the Maverick Quo line.

import { audit } from "@/lib/audit-log";
import { sendMessageWithId } from "@/lib/quo";
import { markApprovalNotified, type ZipRegistryRow } from "@/lib/zip-registry";

const DEFAULT_TARGET = "+16302172539";

export function readOperatorTarget(): string {
  return process.env.MAVERICK_STAGE4_SMS_TARGET ?? DEFAULT_TARGET;
}

export function formatZipApprovalSms(row: ZipRegistryRow): string {
  const where = [row.market, row.state].filter(Boolean).join(", ") || "this market";
  return (
    `AKB — approve ZIP ${row.zip} in ${where} for active outreach?\n` +
    `Reply YES ${row.zip} or NO ${row.zip}.`
  );
}

export interface NotifyResult {
  sent: boolean;
  skipped?: "already_notified" | "no_quo_key";
  messageId?: string | null;
}

export async function notifyZipApprovalPending(row: ZipRegistryRow): Promise<NotifyResult> {
  if (row.approvalNotifiedChannels.includes("sms")) {
    return { sent: false, skipped: "already_notified" };
  }
  if (!process.env.QUO_API_KEY) {
    return { sent: false, skipped: "no_quo_key" };
  }

  const target = readOperatorTarget();
  const body = formatZipApprovalSms(row);
  try {
    const result = await sendMessageWithId(target, body);
    await markApprovalNotified(row, "sms");
    await audit({
      agent: "scout",
      event: "zip_approval_sms_sent",
      status: "confirmed_success",
      inputSummary: { zip: row.zip, market: row.market, target },
      outputSummary: { quo_message_id: result.id, quo_status: result.status },
      externalId: result.id ?? undefined,
    });
    return { sent: true, messageId: result.id };
  } catch (err) {
    await audit({
      agent: "scout",
      event: "zip_approval_sms_failed",
      status: "confirmed_failure",
      inputSummary: { zip: row.zip, market: row.market, target },
      outputSummary: { body_preview: body.slice(0, 80) },
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: false };
  }
}
