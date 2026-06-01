// Pipeline_State — transition engine (THE SOLE WRITER).
// @agent: orchestrator
//
// Per spec §6 (LOCKED 2026-05-31): a Vercel-native worker that is the
// only thing that writes `Pipeline_Stage`. It enforces legal-edge
// transitions (transitions.ts), writes Airtable, and writes the
// audit log so every stage change has provenance.
//
// FORWARD-FIRST, ADDITIVE: this lands the writer surface. The existing
// `app/api/orchestrator/advance-stage/route.ts` is refactored to call
// it (legal-edge check is a new guard on top of the existing gate
// machine). Legacy direct writers in `lib/d3-{scrub,cadence}.ts`
// migrate per-scenario in follow-up commits (matching the per-scenario
// retirement principle for Make scenarios). Until then, the field
// docstring on `lib/types.ts:pipelineStage` is the source-of-truth
// reminder that NEW writers must route through this engine.
//
// Dependency-injected for tests: `deps.updateListing`, `deps.audit`,
// `deps.getCurrentStage` all default to the production wiring.
// Pure-ish: I/O happens only via deps; the legal-edge check stays
// pure (transitions.ts).

import { isLegalTransition, type LegalityOpts, type LegalityResult } from "./transitions";
import { isPipelineStage, type PipelineStage } from "./stages";
import { updateListingRecord, getListing } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import type { FieldDrift } from "@/lib/airtable-verify";

export type TransitionTrigger =
  | "orchestrator"   // gate-driven advance (advance-stage route)
  | "d3"             // D3 scrub / cadence auto-actions
  | "resurrection"   // inbound reply after dead
  | "operator"       // manual operator action
  | "intake"         // initial assignment from crawler / intake
  | "backfill";      // derive/backfill apply step (separate operator-reviewed flow)

export interface TransitionRequest {
  recordId: string;
  to: PipelineStage;
  /** Why this transition was requested — surfaces in audit + Spine. */
  reason: string;
  /** Who/what initiated (agent name for audit attribution). */
  attribution: string;
  triggered_by: TransitionTrigger;
  /**
   * Pre-fetched current stage. Omit to have the engine fetch it
   * itself (one extra Airtable read). Pass it when the caller has
   * already loaded the listing — saves the round trip.
   */
  current?: { pipelineStage: PipelineStage | null };
  /** Resurrection (dead → responded|negotiating) — must be set explicitly. */
  resurrection?: boolean;
}

export type TransitionOutcome =
  | "applied"             // stage changed + written
  | "noop"                // from === to, no write
  | "rejected_illegal"    // legal-edge check refused
  | "rejected_record"     // record not found / no recordId
  | "rejected_target";    // target stage is not a valid PipelineStage

export interface TransitionResult {
  ok: boolean;
  outcome: TransitionOutcome;
  recordId: string;
  from: PipelineStage | null;
  to: PipelineStage;
  legality: LegalityResult;
  airtable_drift: FieldDrift[];
  /** ISO timestamp at which the transition was committed. */
  applied_at: string | null;
  /** Wall-clock ms the call took (incl. Airtable round-trips). */
  duration_ms: number;
  /** Human-readable summary (audit/UI). */
  message: string;
}

export interface TransitionDeps {
  updateListing?: (recordId: string, fields: Record<string, unknown>) => Promise<FieldDrift[]>;
  audit?: typeof audit;
  getCurrentStage?: (recordId: string) => Promise<PipelineStage | null>;
  now?: () => Date;
}

const defaultDeps: Required<TransitionDeps> = {
  updateListing: updateListingRecord,
  audit,
  getCurrentStage: async (recordId: string) => {
    const listing = await getListing(recordId);
    if (!listing) return null;
    const s = listing.pipelineStage;
    if (!s || s.trim() === "") return null;
    return isPipelineStage(s) ? s : null;
  },
  now: () => new Date(),
};

/**
 * Transition a listing's Pipeline_Stage. THE SOLE WRITER.
 *
 * Contract:
 *   - Validates legal-edge (transitions.isLegalTransition) BEFORE writing.
 *   - Illegal edge: returns `{ok:false, outcome:"rejected_illegal"}`, audits as
 *     confirmed_failure with the refusal reason. NO Airtable write.
 *   - Self-loop (from === to): no-op, audits as confirmed_success, no write.
 *   - Legal: writes Pipeline_Stage via airtable.updateListingRecord (which
 *     runs patchAndVerify under the hood — drift surfaces in result), audits
 *     as confirmed_success with input/output summaries.
 *   - Audit attribution comes from `attribution` (agent name); the event tag
 *     is always "pipeline_stage_transition" so future Pulse detectors can
 *     filter on one stable string.
 */
export async function transitionStage(
  req: TransitionRequest,
  deps: TransitionDeps = {},
): Promise<TransitionResult> {
  const d: Required<TransitionDeps> = { ...defaultDeps, ...deps };
  const t0 = Date.now();

  // Defensive: empty/invalid target before anything else.
  if (!isPipelineStage(req.to)) {
    const legality: LegalityResult = {
      legal: false,
      reason: "illegal_unknown_stage",
      message: `target "${req.to}" is not a valid PipelineStage`,
    };
    await d.audit({
      agent: req.attribution,
      event: "pipeline_stage_transition",
      status: "confirmed_failure",
      recordId: req.recordId,
      inputSummary: { to: req.to, reason: req.reason, triggered_by: req.triggered_by },
      outputSummary: { outcome: "rejected_target", legality_reason: legality.reason },
      decision: "rejected_target",
      ms: Date.now() - t0,
    });
    return {
      ok: false,
      outcome: "rejected_target",
      recordId: req.recordId,
      from: null,
      to: req.to,
      legality,
      airtable_drift: [],
      applied_at: null,
      duration_ms: Date.now() - t0,
      message: legality.message,
    };
  }

  if (!req.recordId || !req.recordId.startsWith("rec")) {
    const legality: LegalityResult = {
      legal: false,
      reason: "illegal_unknown_stage",
      message: `invalid recordId: "${req.recordId}"`,
    };
    return {
      ok: false,
      outcome: "rejected_record",
      recordId: req.recordId,
      from: null,
      to: req.to,
      legality,
      airtable_drift: [],
      applied_at: null,
      duration_ms: Date.now() - t0,
      message: legality.message,
    };
  }

  // Resolve current stage (caller-provided or fetched).
  const from: PipelineStage | null = req.current
    ? req.current.pipelineStage
    : await d.getCurrentStage(req.recordId);

  const opts: LegalityOpts = { resurrection: req.resurrection };
  const legality = isLegalTransition(from, req.to, opts);

  if (!legality.legal) {
    await d.audit({
      agent: req.attribution,
      event: "pipeline_stage_transition",
      status: "confirmed_failure",
      recordId: req.recordId,
      inputSummary: {
        from,
        to: req.to,
        reason: req.reason,
        triggered_by: req.triggered_by,
        resurrection: req.resurrection ?? false,
      },
      outputSummary: { outcome: "rejected_illegal", legality_reason: legality.reason },
      decision: legality.reason,
      ms: Date.now() - t0,
    });
    return {
      ok: false,
      outcome: "rejected_illegal",
      recordId: req.recordId,
      from,
      to: req.to,
      legality,
      airtable_drift: [],
      applied_at: null,
      duration_ms: Date.now() - t0,
      message: legality.message,
    };
  }

  // No-op short-circuit. Audit so the call is still traceable, but no Airtable write.
  if (legality.reason === "ok_noop") {
    await d.audit({
      agent: req.attribution,
      event: "pipeline_stage_transition",
      status: "confirmed_success",
      recordId: req.recordId,
      inputSummary: { from, to: req.to, reason: req.reason, triggered_by: req.triggered_by },
      outputSummary: { outcome: "noop" },
      decision: "noop",
      ms: Date.now() - t0,
    });
    return {
      ok: true,
      outcome: "noop",
      recordId: req.recordId,
      from,
      to: req.to,
      legality,
      airtable_drift: [],
      applied_at: d.now().toISOString(),
      duration_ms: Date.now() - t0,
      message: legality.message,
    };
  }

  // Legal + not a noop → write.
  const drift = await d.updateListing(req.recordId, { Pipeline_Stage: req.to });
  const applied_at = d.now().toISOString();

  await d.audit({
    agent: req.attribution,
    event: "pipeline_stage_transition",
    status: "confirmed_success",
    recordId: req.recordId,
    inputSummary: {
      from,
      to: req.to,
      reason: req.reason,
      triggered_by: req.triggered_by,
      resurrection: req.resurrection ?? false,
    },
    outputSummary: {
      outcome: "applied",
      legality_reason: legality.reason,
      airtable_drift_count: drift.length,
    },
    decision: legality.reason,
    ms: Date.now() - t0,
  });

  return {
    ok: true,
    outcome: "applied",
    recordId: req.recordId,
    from,
    to: req.to,
    legality,
    airtable_drift: drift,
    applied_at,
    duration_ms: Date.now() - t0,
    message: `${legality.message} (drift_count=${drift.length})`,
  };
}
