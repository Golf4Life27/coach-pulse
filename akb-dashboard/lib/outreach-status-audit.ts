// INV — Outreach_Status truth audit (pure).
//
// Investigation 2026-06-08: every "Response Received" record in the table
// (30 of them, across MI/TX/TN) lacks a recorded inbound timestamp, and
// the legit reply-detection path (app/api/scan-replies) ALWAYS writes
// Last_Inbound_At — so these statuses were not written by the reply path.
// This classifies each record's status against the only ground truth we
// can read without a conversation fetch: did we ever even contact them?
//
// The verdicts are deliberately conservative — we only CONFIDENTLY correct
// what is logically impossible (a reply with no outbound ever sent). A
// texted-but-no-recorded-inbound record is left for a conversation check
// (Quo/Gmail), because Last_Inbound_At is not reliably written by every
// inbound path (e.g. the Make L3 webhook), so its absence is suggestive,
// not proof.

/** Statuses that ASSERT an inbound reply happened. "Response Received" is
 *  the one this investigation found corrupted; the others are included so
 *  the same audit catches a Negotiating/Counter/Offer-Accepted record that
 *  was never contacted. */
export const REPLY_IMPLYING_STATUSES: ReadonlySet<string> = new Set([
  "Response Received",
  "Counter Received",
  "Negotiating",
  "Offer Accepted",
]);

export type OutreachTruthVerdict = "supported" | "impossible" | "unverified" | "not_applicable";

export interface OutreachAuditInput {
  id: string;
  address: string | null;
  state: string | null;
  sourceVersion: string | null;
  outreachStatus: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  executionPath: string | null;
}

export interface OutreachAuditFinding {
  id: string;
  address: string | null;
  state: string | null;
  outreachStatus: string | null;
  executionPath: string | null;
  hasInbound: boolean;
  hasOutbound: boolean;
  verdict: OutreachTruthVerdict;
  /** Proposed corrected Outreach_Status. null = no change (supported) or
   *  hold for review (unverified). "" = revert to pre-outreach empty. */
  proposedStatus: string | null;
  needsConversationCheck: boolean;
  reasoning: string;
}

function nonEmpty(v: string | null): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/** Pure: classify one record's reply-claiming status against contact signals. */
export function classifyOutreachTruth(input: OutreachAuditInput): OutreachAuditFinding {
  const status = input.outreachStatus ?? "";
  const hasInbound = nonEmpty(input.lastInboundAt);
  const hasOutbound = nonEmpty(input.lastOutboundAt);
  const base = {
    id: input.id,
    address: input.address,
    state: input.state,
    outreachStatus: input.outreachStatus,
    executionPath: input.executionPath,
    hasInbound,
    hasOutbound,
  };

  if (!REPLY_IMPLYING_STATUSES.has(status)) {
    return { ...base, verdict: "not_applicable", proposedStatus: null, needsConversationCheck: false, reasoning: "status does not assert an inbound reply" };
  }

  if (hasInbound) {
    return {
      ...base,
      verdict: "supported",
      proposedStatus: null,
      needsConversationCheck: false,
      reasoning: `recorded inbound (${input.lastInboundAt}) backs the reply status — keep`,
    };
  }

  if (!hasOutbound) {
    return {
      ...base,
      verdict: "impossible",
      // Never contacted → revert to pre-outreach empty so the engine can
      // re-derive a clean stage. Execution_Path stays as-is (a Reject
      // record stays rejected; an Auto-Proceed record becomes re-eligible).
      proposedStatus: "",
      needsConversationCheck: false,
      reasoning: "no outbound was ever sent — a reply is impossible; revert Outreach_Status to empty (engine re-derives stage)",
    };
  }

  return {
    ...base,
    verdict: "unverified",
    proposedStatus: "Texted",
    needsConversationCheck: true,
    reasoning: `texted (${input.lastOutboundAt}) but no recorded inbound — confirm against Quo/Gmail; if a real reply exists keep "Response Received", else set "Texted"`,
  };
}

export interface OutreachAuditSummary {
  total_reply_claiming: number;
  supported: number;
  impossible: number;
  unverified: number;
  by_state: Record<string, number>;
}

/** Pure: classify a set, returning findings (reply-claiming only) + summary. */
export function auditOutreachStatuses(inputs: OutreachAuditInput[]): {
  findings: OutreachAuditFinding[];
  summary: OutreachAuditSummary;
} {
  const findings = inputs
    .map(classifyOutreachTruth)
    .filter((f) => f.verdict !== "not_applicable");

  const by_state: Record<string, number> = {};
  for (const f of findings) {
    const s = f.state ?? "??";
    by_state[s] = (by_state[s] ?? 0) + 1;
  }
  // Riskiest first: impossible, then unverified, then supported.
  const order: Record<OutreachTruthVerdict, number> = { impossible: 0, unverified: 1, supported: 2, not_applicable: 3 };
  findings.sort((a, b) => order[a.verdict] - order[b.verdict]);

  return {
    findings,
    summary: {
      total_reply_claiming: findings.length,
      supported: findings.filter((f) => f.verdict === "supported").length,
      impossible: findings.filter((f) => f.verdict === "impossible").length,
      unverified: findings.filter((f) => f.verdict === "unverified").length,
      by_state,
    },
  };
}
