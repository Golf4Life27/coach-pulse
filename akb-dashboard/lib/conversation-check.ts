// Conversation-check classifier for the "unverified" set surfaced by
// /api/admin/outreach-status-audit.
//
// The 5/19 unverified records (texted but no recorded Last_Inbound_At)
// could be either:
//   (a) genuine replies that Make-L3 wrote the status for without
//       stamping the timestamp, OR
//   (b) phantom statuses written by a defective off-platform path.
// The only way to tell is to look at the actual Quo thread.
//
// This module is the pure half — classify a list of QuoMessages against
// a record's outreach window. The route consumes it after fetching the
// thread. The rejection-pattern set is intentionally a subset of
// lib/resurrection's REJECTION_PATTERNS (don't re-stamp a record as
// "Response Received" if the inbound was actually a hard-no).

export interface InboundCheckMessage {
  direction: "incoming" | "outgoing";
  body: string;
  createdAt: string;
}

export type ConversationVerdict =
  | { verdict: "keep_response_received"; firstInboundAt: string; inboundCount: number; reason: string }
  | { verdict: "downgrade_to_texted"; reason: string; inboundCount: 0 }
  | { verdict: "downgrade_to_dead"; reason: string; firstInboundAt: string }
  | { verdict: "uncertain"; reason: string };

const REJECTION_PATTERNS = [
  /\bno\s+thanks?\b/i,
  /\bnot\s+interested\b/i,
  /\bpass\b/i,
  /\bsold\b/i,
  /\bunder\s+contract\b/i,
  /\bstop\b/i,
  /\bremove\s+me\b/i,
  /\bunsubscribe\b/i,
  /\btake\s+me\s+off\b/i,
  /\bdo\s+not\s+(?:contact|call|text)\b/i,
];

/** Pure: decide what the record's Outreach_Status SHOULD be based on
 *  the conversation. `lastOutboundAt` is the H2-send time; inbounds
 *  AFTER that are real replies to our outreach. Inbounds before are
 *  ignored — they're pre-outreach noise. */
export function classifyConversation(
  messages: InboundCheckMessage[],
  lastOutboundAt: string | null,
): ConversationVerdict {
  if (!lastOutboundAt) {
    // No outbound — there's nothing to be a reply TO. The audit
    // shouldn't have surfaced this record (impossible, not unverified)
    // but be defensive.
    return { verdict: "uncertain", reason: "no_outbound_to_reference" };
  }
  const outT = Date.parse(lastOutboundAt);
  if (!Number.isFinite(outT)) {
    return { verdict: "uncertain", reason: "last_outbound_unparseable" };
  }

  const repliesAfterOutreach = messages
    .filter((m) => m.direction === "incoming")
    .filter((m) => {
      const t = Date.parse(m.createdAt);
      return Number.isFinite(t) && t >= outT;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  if (repliesAfterOutreach.length === 0) {
    return {
      verdict: "downgrade_to_texted",
      reason: "no_inbound_after_outreach",
      inboundCount: 0,
    };
  }

  const firstInboundAt = repliesAfterOutreach[0].createdAt;

  // If EVERY reply matches a rejection pattern, the agent said no —
  // status should be Dead, not Response Received.
  const allRejections = repliesAfterOutreach.every((m) =>
    REJECTION_PATTERNS.some((p) => p.test(m.body)),
  );
  if (allRejections) {
    return {
      verdict: "downgrade_to_dead",
      reason: "all_inbounds_match_rejection_patterns",
      firstInboundAt,
    };
  }

  return {
    verdict: "keep_response_received",
    firstInboundAt,
    inboundCount: repliesAfterOutreach.length,
    reason: "non_rejection_inbound_after_outreach",
  };
}
