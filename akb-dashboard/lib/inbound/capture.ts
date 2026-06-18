// M6 — the capture decision (pure heart of Reply Capture). @agent: outreach
//
// One genuine inbound reply → a CapturePlan the caller executes behind the
// live flag. Reuses the EXISTING triage stack (no parallel copies):
//   - conversation-check.isSelfEchoOrAutoreply  (strip our echo / bot replies)
//   - reply-triage.triageSellerReply            (classify + route + reason)
//   - l3-amount-detector.detectL3DollarAmounts  (negotiation-point escalation)
//
// FAIL-CLOSED: a reply that matches no live listing is NEVER dropped — it
// becomes an unmatched (catch-all) plan. PURE — no I/O.

import { isSelfEchoOrAutoreply } from "@/lib/conversation-check";
import { triageSellerReply, type SellerReplyTriage } from "@/lib/reply-triage";
import { detectL3DollarAmounts, type L3AmountDetection } from "@/lib/outreach/l3-amount-detector";
import { matchInboundToListing } from "./match";
import { buildUnmatchedReplyFields, type UnmatchedReplyFields } from "./catch-all";
import type { InboundMessage, MatchableListing } from "./types";

export type CapturePlan =
  | { kind: "ignored"; reason: "empty" | "self_echo_or_autoreply" }
  | {
      kind: "matched";
      listingId: string;
      currentStatus: string | null;
      triage: SellerReplyTriage;
      /** Outreach_Status to move the record to (null = no change). */
      newStatus: string | null;
      escalate: boolean;
      amounts: L3AmountDetection;
    }
  | {
      kind: "unmatched";
      fields: UnmatchedReplyFields;
      triage: SellerReplyTriage;
      escalate: boolean;
    };

/** Pure: decide what to do with one inbound reply.
 *  empty / self-echo / bot-autoreply → ignored;
 *  matched to a live listing → matched plan (notes append + status + escalate);
 *  no match → unmatched plan (fail-closed catch-all). */
export function planInboundCapture(
  msg: InboundMessage,
  listings: MatchableListing[],
): CapturePlan {
  if (!msg.body || !msg.body.trim()) return { kind: "ignored", reason: "empty" };
  if (isSelfEchoOrAutoreply(msg.body)) return { kind: "ignored", reason: "self_echo_or_autoreply" };

  const amounts = detectL3DollarAmounts(msg.body);
  const listing = matchInboundToListing(msg, listings);
  const triage = triageSellerReply(msg.body, listing?.outreachStatus ?? null);

  if (!listing) {
    return {
      kind: "unmatched",
      fields: buildUnmatchedReplyFields(msg, triage, amounts),
      triage,
      escalate: amounts.shouldEscalate,
    };
  }
  return {
    kind: "matched",
    listingId: listing.id,
    currentStatus: listing.outreachStatus ?? null,
    triage,
    newStatus: triage.queueStatus,
    escalate: amounts.shouldEscalate,
    amounts,
  };
}
