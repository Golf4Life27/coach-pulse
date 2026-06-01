// Pipeline_State — canonical stage definitions.
// @agent: maverick / orchestrator
//
// Per Pipeline_State Spec v1 (LOCKED 2026-05-31, docs/specs/Pipeline_State_Spec_v1.md),
// `Pipeline_Stage` (Airtable field id fldJt2pSCHiXqBxwj on Listings_V1) is the
// single source of truth for "where is this deal." This module owns the
// canonical declaration of the value set.
//
// Decision #2 (locked): a `responded` stage was added between `outreach_sent`
// and `negotiating` to preserve the "agent replied, not yet engaged" signal
// (Outreach_Status=Response Received) that cadence depends on.
//
// `lib/orchestrator/types.ts` re-exports from this module so all consumers of
// the orchestrator's `PipelineStage` type pick up the new value automatically.
//
// Pure. No I/O.

/**
 * Canonical 13-value lifecycle. Forward path:
 *   intake → verified → priced → outreach_ready → outreach_sent
 *   → responded → negotiating → offer_drafted → under_contract
 *   → dispo_active → assignment_signed → closed
 * Terminal failure: `dead` (reachable from any non-terminal).
 *
 * Array order MUST match the lifecycle order — STAGE_ORDER below
 * derives ordinal positions from it, and the >= comparisons in
 * `isUnderContract` (and downstream consumers) depend on that.
 */
export const ALL_PIPELINE_STAGES = [
  "intake",
  "verified",
  "priced",
  "outreach_ready",
  "outreach_sent",
  "responded",
  "negotiating",
  "offer_drafted",
  "under_contract",
  "dispo_active",
  "assignment_signed",
  "closed",
  "dead",
] as const;

export type PipelineStage = (typeof ALL_PIPELINE_STAGES)[number];

/**
 * Ordinal position of each stage in the forward lifecycle. Used by
 * stage-based `isUnderContract` (>= "under_contract") and by the
 * engine's legal-transition check to enforce "forward one step only."
 *
 * `dead` is the terminal-failure sink — given its own large ordinal
 * (END) so `STAGE_ORDER["dead"] > STAGE_ORDER[<anything else>]` holds,
 * but no forward edge points TO it (transitions to `dead` are the
 * kill edge, handled separately in `isLegalTransition`).
 */
export const STAGE_ORDER: Record<PipelineStage, number> = (() => {
  const order = {} as Record<PipelineStage, number>;
  // Forward-path positions 0..11 in array order, skipping `dead` (last).
  const forward = ALL_PIPELINE_STAGES.filter((s) => s !== "dead");
  forward.forEach((s, i) => {
    order[s] = i;
  });
  order["dead"] = 9999;
  return order;
})();

/** Stages from which no forward transition is legal. */
export const TERMINAL_STAGES: ReadonlySet<PipelineStage> = new Set([
  "closed",
  "dead",
]);

/** Convenience: non-terminal stages (every kill edge starts from one of these). */
export const LIVE_STAGES: readonly PipelineStage[] = ALL_PIPELINE_STAGES.filter(
  (s) => !TERMINAL_STAGES.has(s),
);

/** Type guard. */
export function isPipelineStage(v: unknown): v is PipelineStage {
  return typeof v === "string" && (ALL_PIPELINE_STAGES as readonly string[]).includes(v);
}
