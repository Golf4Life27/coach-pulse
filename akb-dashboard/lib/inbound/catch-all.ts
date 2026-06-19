// M6 — the fail-closed catch-all. @agent: outreach
//
// Any inbound reply that matches no live listing becomes an Unmatched_Replies
// row (operator's "still a reply you must see" surface). The row carries the
// triage so the operator sees WHAT the reply needs, not a bare body. PURE —
// builds the Airtable field payload (by field NAME; the store writes with
// typecast). Idempotent by channel + external id.

import type { InboundMessage } from "./types";
import type { SellerReplyTriage } from "@/lib/reply-triage";
import type { L3AmountDetection } from "@/lib/outreach/l3-amount-detector";

/** Unmatched_Replies row, keyed by Airtable field NAME → value. */
export type UnmatchedReplyFields = Record<string, unknown>;

/** Pure: idempotency key for an unmatched reply — channel + external id. */
export function unmatchedReplyKey(msg: InboundMessage): string {
  return `${msg.channel}:${msg.externalId}`;
}

/** Pure: build the Unmatched_Replies row for a reply that matched no live
 *  listing. Never drops — this is the fail-closed surface. */
export function buildUnmatchedReplyFields(
  msg: InboundMessage,
  triage: SellerReplyTriage,
  amounts: L3AmountDetection,
): UnmatchedReplyFields {
  return {
    Key: unmatchedReplyKey(msg),
    Channel: msg.channel,
    Sender: msg.sender,
    Body: msg.body,
    Received_At: msg.receivedAt,
    Thread_Id: msg.threadId ?? "",
    Subject: msg.subject ?? "",
    Classification: triage.classification,
    Tier: triage.tier,
    Escalate: amounts.shouldEscalate,
    Amounts: amounts.amounts.map((a) => `$${a.amountUsd.toLocaleString()}`).join(", "),
    Reasoning: triage.reasoning,
    Status: "New",
  };
}
