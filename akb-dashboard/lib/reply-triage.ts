// Seller-reply triage — the single source of truth for classifying an
// inbound SMS reply and routing it to the right needs-decision queue.
//
// Two consumers share this module (no parallel copies):
//   - /api/scan-replies   sets the record's Outreach_Status from the
//                         classification (the queue STATE on the record).
//   - /api/cron/scan-comms attaches the triage to the jarvis_reply proposal
//                         (the queue ITEM the operator acts on), so a genuine
//                         seller reply arrives with WHAT decision it needs,
//                         not a bare echo of the text.
//
// Self-echo / bot-autoreply stripping lives in lib/conversation-check.ts
// (isSelfEchoOrAutoreply); callers filter those out BEFORE triage — this
// module assumes the body is a genuine human inbound.
//
// Pure. No I/O. Tested in lib/reply-triage.test.ts.

export type ReplyClassification = "rejection" | "interest" | "counter" | "unknown";

const REJECTION_PATTERNS = [
  /\bnot interested\b/i,
  /\bno thanks?\b/i,
  /\bstop\b/i,
  /\btoo low\b/i,
  /\bseller said no\b/i,
  /\bfirm at\b/i,
  /\bunder contract\b/i,
  /\boff the market\b/i,
  /\bsold\b/i,
  /\bexpired\b/i,
  /\bpass\b/i,
  /\bnot for sale\b/i,
  /\bremove\b.*\bnumber\b/i,
  /\bdo not\b.*\b(text|contact|call)\b/i,
  /\bunsubscribe\b/i,
  /\bno longer\b.*\b(available|listed)\b/i,
  /\bwithdrawn\b/i,
  /\bpending\b/i,
];

const INTEREST_PATTERNS = [
  /\byes\b/i,
  /\binterested\b/i,
  /\bsend\s*(me|it|the|a|your)\b/i,
  /\bsend\s*offer\b/i,
  /\bcounter\b/i,
  /\bcome up\b/i,
  /\bbest offer\b/i,
  /\bproof of funds\b/i,
  /\bemail\s*me\b/i,
  /\bcall\s*me\b/i,
  /\bsubmit\b/i,
  /\bhow\s*(much|soon|quick)\b/i,
  /\bwhat.*offer\b/i,
  /\bcan you\s*(do|go|come)\b/i,
  /\bwould\s*you\s*consider\b/i,
  /\blet'?s\s*talk\b/i,
  /\$\s*\d/i, // dollar amount mentioned
];

// A counter is detected when the seller quotes a specific number range or
// floor — distinct from a generic interest signal. We require a price
// reference plus counter-flavored language.
const COUNTER_PRICE_RE = /\$\s*\d{1,3}[\s,.]?(?:\d{3}|k)\b/i;
const COUNTER_LANGUAGE_PATTERNS = [
  /\bcounter\b/i,
  /\bcome\s+(?:up|down)\b/i,
  /\bin\s+the\s+\$?\d/i,
  /\b(?:looking|hoping)\s+(?:for|at)\s+\$?\d/i,
  /\bbest\s+(?:and\s+)?final\b/i,
  /\bnet\s+(?:to|of)\b/i,
  /\bhighest\s+(?:we'?ll|i'?ll|they'?ll)\s+(?:go|do)\b/i,
  /\b(?:lowest|min(?:imum)?)\s+(?:they|seller|we)\b/i,
  /\bmeet\s+(?:in\s+the\s+)?middle\b/i,
  /\bif\s+you\s+can\s+(?:do|come|go)\s+\$?\d/i,
];

/** Pure: classify a genuine inbound reply. Rejection wins over everything
 *  (a "not interested at $X" is still a rejection). A counter needs BOTH a
 *  price token AND counter language; otherwise a price/interest signal is
 *  plain interest. */
export function classifyReply(body: string): {
  classification: ReplyClassification;
  matchedPattern: string | null;
} {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return { classification: "unknown", matchedPattern: null };

  for (const pat of REJECTION_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "rejection", matchedPattern: pat.source };
  }

  if (COUNTER_PRICE_RE.test(trimmed)) {
    for (const pat of COUNTER_LANGUAGE_PATTERNS) {
      if (pat.test(trimmed)) return { classification: "counter", matchedPattern: pat.source };
    }
  }

  for (const pat of INTEREST_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "interest", matchedPattern: pat.source };
  }

  return { classification: "unknown", matchedPattern: null };
}

/** Pure: the Outreach_Status a reply should move the record to, given its
 *  current status. null = no change. Rejection → Dead; counter → Counter
 *  Received (resurrects a Dead record); interest → Negotiating; an unknown
 *  but genuine reply only promotes a still-"Texted" record to Response
 *  Received (never downgrades an already-advanced record). */
export function determineNewStatus(
  classification: ReplyClassification,
  currentStatus: string | null,
): string | null {
  if (classification === "rejection") return "Dead";
  if (classification === "counter") {
    if (currentStatus === "Counter Received") return null;
    return "Counter Received";
  }
  if (classification === "interest") return "Negotiating";
  if (currentStatus === "Texted") return "Response Received";
  return null;
}

/** What kind of operator decision a genuine reply demands. */
export type DecisionKind = "pricing" | "engagement" | "review" | "none";

export interface SellerReplyTriage {
  classification: ReplyClassification;
  /** True when this genuine reply needs an operator decision (i.e. it is not
   *  a clean rejection, which is a downgrade rather than a decision). */
  needsDecision: boolean;
  decisionKind: DecisionKind;
  /** Proposal priority — pricing/engagement decisions are time-sensitive. */
  priority: "HIGH" | "NORMAL";
  /** The needs-decision queue status this reply routes the record to (same
   *  mapping as determineNewStatus). */
  queueStatus: string | null;
  /** Operator-facing: what the seller said + what decision is needed. */
  reasoning: string;
  matchedPattern: string | null;
}

/** Pure: turn a genuine inbound reply into a routed, reasoned needs-decision
 *  item. The caller has already stripped self-echo / bot autoreplies. */
export function triageSellerReply(
  body: string,
  currentStatus: string | null = null,
): SellerReplyTriage {
  const { classification, matchedPattern } = classifyReply(body);
  const queueStatus = determineNewStatus(classification, currentStatus);
  const snippet = (body ?? "").trim().slice(0, 160);

  switch (classification) {
    case "counter":
      return {
        classification,
        needsDecision: true,
        decisionKind: "pricing",
        priority: "HIGH",
        queueStatus,
        reasoning: `Seller countered with a price — operator PRICING decision needed (hold the sticky floor; never auto-revise down). Reply: "${snippet}"`,
        matchedPattern,
      };
    case "interest":
      return {
        classification,
        needsDecision: true,
        decisionKind: "engagement",
        priority: "HIGH",
        queueStatus,
        reasoning: `Seller engaged / asked to proceed — operator decision: advance to offer or DD. Reply: "${snippet}"`,
        matchedPattern,
      };
    case "rejection":
      return {
        classification,
        needsDecision: false,
        decisionKind: "none",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Seller declined (matched /${matchedPattern}/) — route to Dead, no offer. Reply: "${snippet}"`,
        matchedPattern,
      };
    default:
      return {
        classification,
        needsDecision: true,
        decisionKind: "review",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Genuine reply, intent unclear — operator review. Reply: "${snippet}"`,
        matchedPattern,
      };
  }
}
