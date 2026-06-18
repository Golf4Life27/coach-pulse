// Pre-Contract operator hand-off (M7 Part 1, operator 2026-06-18).
// @agent: orchestrator
//
// The clean stop BEFORE the contract wall. Hop 7 (Pre-Contract / DocuSign)
// is OUT of first-light scope — contracts are operator-signed. A lead that
// reaches the Pre-Contract gate must therefore SURFACE to the operator for
// signature, never throw a DocuSign error or crash the belt.
//
// runGate already fails closed at this boundary: with DocuSign unwired the
// pa_document source rejects (caught by the Promise.allSettled fan-out) and
// its items resolve to data_missing, so the gate can never `pass` and nothing
// auto-advances to under_contract. This PURE helper reads that result and
// tells the belt/UI HOW to surface it:
//   - blocked ONLY by missing data (DocuSign signature, etc.) → route the
//     lead to the operator (Manual Review) as "awaiting operator signature".
//   - blocked by a genuine business-rule FAIL (assignability, math, …) →
//     a real block; surface as blocked, still never advanced.
// Either way the lead stops cleanly at the operator — never silent-forwarded.
//
// Pure. No I/O. Advances nothing; only recommends how to surface the lead.

import type { GateRunResult } from "./types";

export interface PreContractHandoff {
  /** True when the lead should be parked for the operator to sign. */
  surfaceToOperator: boolean;
  /** Outreach_Status to set when surfacing (null when not surfacing). */
  outreachStatus: "Manual Review" | null;
  /** Stable machine-readable reason. */
  reason:
    | "awaiting_operator_signature"
    | "blocked_by_rule"
    | "passed_no_handoff_needed"
    | "not_pre_contract";
  /** Genuine business-rule failures (status=fail), if any. */
  realBlockers: string[];
  /** Items missing data (DocuSign signature + any other), if any. */
  pendingData: string[];
  /** Human-readable one-liner for the operator surface. */
  message: string;
}

/**
 * Pure: classify a Pre-Contract gate result into a clean operator hand-off.
 * Never advances anything; only recommends how to surface the lead so the
 * belt reaches the operator cleanly instead of throwing at the DocuSign wall.
 */
export function preContractOperatorHandoff(result: GateRunResult): PreContractHandoff {
  if (result.gate_id !== "pre_contract") {
    return {
      surfaceToOperator: false,
      outreachStatus: null,
      reason: "not_pre_contract",
      realBlockers: [],
      pendingData: [],
      message: `preContractOperatorHandoff called on non-pre_contract gate "${result.gate_id}" — no-op.`,
    };
  }

  const realBlockers = [...result.blockers];
  const pendingData = [...result.data_missing];

  // Defensive: a clean pass needs no hand-off (cannot happen while DocuSign
  // is unwired, but never assume it).
  if (result.overall_status === "pass") {
    return {
      surfaceToOperator: false,
      outreachStatus: null,
      reason: "passed_no_handoff_needed",
      realBlockers,
      pendingData,
      message: "Pre-Contract gate passed — no operator hand-off needed.",
    };
  }

  // Genuine business-rule failure → a real block, NOT a clean signature
  // hand-off. Still fail-closed: the lead never advances; the operator
  // reviews the violated rule.
  if (realBlockers.length > 0) {
    return {
      surfaceToOperator: false,
      outreachStatus: null,
      reason: "blocked_by_rule",
      realBlockers,
      pendingData,
      message: `Pre-Contract blocked by rule(s): ${realBlockers.join(", ")}. Lead held — not a clean signature hand-off.`,
    };
  }

  // Blocked only by missing data (DocuSign signature unwired, etc.) → the
  // clean operator hand-off: park at Manual Review for signature.
  return {
    surfaceToOperator: true,
    outreachStatus: "Manual Review",
    reason: "awaiting_operator_signature",
    realBlockers,
    pendingData,
    message: `Lead ready for the contract step — awaiting operator signature (DocuSign unwired for first light). Pending: ${pendingData.join(", ") || "pa_document"}. Surfaced to operator (Manual Review).`,
  };
}
