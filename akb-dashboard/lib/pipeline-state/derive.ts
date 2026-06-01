// Pipeline_State — legacy → stage derivation (DRY-RUN ONLY).
// @agent: maverick / orchestrator
//
// Per spec §7 step 4 (LOCKED 2026-05-31): the mass backfill of
// Pipeline_Stage from the existing tangle is a SEPARATE, operator-
// reviewed, dry-run-first step — NOT auto-applied by this commit.
//
// This module ships the pure mapping function the future backfill +
// dry-run report will consume. It MUST NEVER write Airtable. The
// engine (engine.ts) does not call this — its purpose is to produce
// a report for the operator to review before any apply step.
//
// Pure. No I/O.

import type { PipelineStage } from "./stages";

/**
 * Minimal listing shape the derivation needs. Kept narrow so the
 * dry-run report can run against any Listing subset (e.g., a
 * read-only snapshot pulled by the backfill route).
 */
export interface DerivableListing {
  pipelineStage?: string | null;
  outreachStatus?: string | null;
  executionPath?: string | null;
  liveStatus?: string | null;
  envelopeId?: string | null;
  contractOfferPrice?: number | null;
}

export type DerivationConfidence = "high" | "medium" | "low";

export interface DerivationResult {
  stage: PipelineStage;
  confidence: DerivationConfidence;
  /** Stable reason code (machine-readable for dry-run aggregation). */
  reason:
    | "pipeline_stage_already_set"
    | "envelope_or_contract_signed"
    | "offer_drafted_signal"
    | "negotiating_signal"
    | "responded_signal"
    | "outreach_sent_signal"
    | "outreach_ready_signal"
    | "verified_held_for_review"
    | "intake_rejected"
    | "dead_signal"
    | "intake_default";
  /** Human-readable explanation (audit/UI). */
  message: string;
  /** Any contradicting signals worth surfacing in the dry-run report. */
  conflicts: string[];
}

const PROGRESSED_OUTREACH = new Set([
  "Texted",
  "Texted (Portfolio)",
  "Emailed",
  "Response Received",
  "Negotiating",
  "Counter Received",
  "Offer Accepted",
  "Contract Signed",
]);

/**
 * Pure: derive the canonical `Pipeline_Stage` value from the legacy
 * field tangle for one record. Used by the operator-reviewed dry-run
 * backfill — do NOT call from any write path.
 *
 * Precedence (most-specific wins; rationale per spec §3 mapping table):
 *   1. `pipelineStage` already set → keep it (no derivation needed).
 *   2. Dead signal (`Outreach_Status=Dead`) → `dead`.
 *   3. Envelope_ID set OR `Outreach_Status=Contract Signed` → `under_contract`.
 *   4. `contractOfferPrice` set OR `Outreach_Status=Offer Accepted` → `offer_drafted`.
 *   5. `Outreach_Status ∈ {Negotiating, Counter Received}` → `negotiating`.
 *   6. `Outreach_Status=Response Received` → `responded`.
 *   7. `Outreach_Status ∈ {Texted, Emailed, Texted (Portfolio)}` → `outreach_sent`.
 *   8. `Execution_Path=Reject` AND no progressed Outreach_Status → `dead` (intake-reject).
 *   9. `Outreach_Status ∈ {Review, Manual Review}` → `verified` (held for review).
 *  10. Empty `Outreach_Status` AND `Execution_Path=Auto Proceed` AND `Live_Status=Active`
 *      → `outreach_ready`.
 *  11. Default → `intake`.
 *
 * Confidence:
 *   - high: multiple agreeing signals (e.g., Envelope_ID + Contract Signed).
 *   - medium: single decisive signal, no contradictions.
 *   - low: a contradicting signal was present (e.g., the 23 Fields case —
 *          `Negotiating` + `Reject` — derived to `negotiating` but the
 *          intake-reject is flagged as a conflict for operator review).
 */
export function deriveStageFromLegacy(l: DerivableListing): DerivationResult {
  const conflicts: string[] = [];
  const os = (l.outreachStatus ?? "").trim();
  const ep = (l.executionPath ?? "").trim();
  const ls = (l.liveStatus ?? "").trim();

  // 1. Already populated — keep, do not derive.
  if (l.pipelineStage && l.pipelineStage.trim() !== "") {
    return {
      stage: l.pipelineStage as PipelineStage,
      confidence: "high",
      reason: "pipeline_stage_already_set",
      message: `pipelineStage="${l.pipelineStage}" already populated — no derivation`,
      conflicts: [],
    };
  }

  // Track conflicts so 23-Fields-class records get flagged for operator review.
  if (ep === "Reject" && PROGRESSED_OUTREACH.has(os)) {
    conflicts.push(`Execution_Path=Reject but Outreach_Status=${os} — intake gate contradicts negotiation state`);
  }

  // 2. Dead signal.
  if (os === "Dead") {
    return {
      stage: "dead",
      confidence: conflicts.length > 0 ? "low" : "high",
      reason: "dead_signal",
      message: `Outreach_Status=Dead → dead`,
      conflicts,
    };
  }

  // 3. Under contract.
  if (l.envelopeId || os === "Contract Signed") {
    return {
      stage: "under_contract",
      confidence: l.envelopeId && os === "Contract Signed" ? "high" : "medium",
      reason: "envelope_or_contract_signed",
      message: l.envelopeId
        ? `Envelope_ID set → under_contract`
        : `Outreach_Status=Contract Signed → under_contract`,
      conflicts,
    };
  }

  // 4. Offer drafted.
  if (l.contractOfferPrice != null || os === "Offer Accepted") {
    return {
      stage: "offer_drafted",
      confidence: l.contractOfferPrice != null && os === "Offer Accepted" ? "high" : "medium",
      reason: "offer_drafted_signal",
      message: l.contractOfferPrice != null
        ? `contractOfferPrice=$${l.contractOfferPrice} → offer_drafted`
        : `Outreach_Status=Offer Accepted → offer_drafted`,
      conflicts,
    };
  }

  // 5. Negotiating.
  if (os === "Negotiating" || os === "Counter Received") {
    return {
      stage: "negotiating",
      confidence: conflicts.length > 0 ? "low" : "medium",
      reason: "negotiating_signal",
      message: `Outreach_Status=${os} → negotiating`,
      conflicts,
    };
  }

  // 6. Responded.
  if (os === "Response Received") {
    return {
      stage: "responded",
      confidence: conflicts.length > 0 ? "low" : "medium",
      reason: "responded_signal",
      message: `Outreach_Status=Response Received → responded`,
      conflicts,
    };
  }

  // 7. Outreach sent.
  if (os === "Texted" || os === "Texted (Portfolio)" || os === "Emailed") {
    return {
      stage: "outreach_sent",
      confidence: conflicts.length > 0 ? "low" : "medium",
      reason: "outreach_sent_signal",
      message: `Outreach_Status=${os} → outreach_sent`,
      conflicts,
    };
  }

  // 8. Intake reject (no progressed outreach to contradict it).
  if (ep === "Reject") {
    return {
      stage: "dead",
      confidence: "high",
      reason: "intake_rejected",
      message: `Execution_Path=Reject (no progressed outreach) → dead (intake-reject)`,
      conflicts,
    };
  }

  // 9. Held for review.
  if (os === "Review" || os === "Manual Review") {
    return {
      stage: "verified",
      confidence: "medium",
      reason: "verified_held_for_review",
      message: `Outreach_Status=${os} → verified (held)`,
      conflicts,
    };
  }

  // 10. Outreach ready.
  const isEmptyOs = os === "";
  if (isEmptyOs && ep === "Auto Proceed" && ls === "Active") {
    return {
      stage: "outreach_ready",
      confidence: "medium",
      reason: "outreach_ready_signal",
      message: `Outreach_Status empty + Execution_Path=Auto Proceed + Live_Status=Active → outreach_ready`,
      conflicts,
    };
  }

  // 11. Default.
  return {
    stage: "intake",
    confidence: "low",
    reason: "intake_default",
    message: `no decisive signal — default to intake`,
    conflicts,
  };
}
