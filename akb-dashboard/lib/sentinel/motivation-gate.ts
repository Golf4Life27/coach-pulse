// Phase 13 / N.4 — Sentinel motivation-write gate.
//
// Pure decision helper for the auto-write step on /api/sentinel/
// classify/[recordId]?apply_motivation=1. Decoupled from the route's
// side-effects so the gate logic (the destructive boundary that
// drives whether Seller_Motivation_Score gets written) is locked
// by unit tests.
//
// Gate rules (ALL required for "apply"):
//   - apply flag set by the caller (operator opted in via query param)
//   - intent ∈ {motivated, lukewarm} — other intents never produce a
//     meaningful motivation hint
//   - motivation_score_hint is a 1-5 integer (already coerced by the
//     classifier)
//   - existing Seller_Motivation_Score IS null — never stomp an
//     operator-set value; the operator's call always wins
//
// Any failure → "skip" with a structured reason the audit log captures.

import type { SentinelClassification } from "./types";

export type MotivationGateDecision =
  | { decision: "apply"; score: number }
  | {
      decision: "skip";
      reason:
        | "not_requested"
        | "intent_not_motivated_or_lukewarm"
        | "no_hint"
        | "existing_score_set";
      existing_score: number | null;
      hint: number | null;
    };

/** Pure: classify whether a motivation auto-write should fire for a
 *  classified inbound. The caller (route or background sweep)
 *  performs the actual Airtable write when decision === "apply". */
export function decideMotivationApply(opts: {
  apply: boolean;
  classification: Pick<SentinelClassification, "intent" | "motivation_score_hint">;
  existingScore: number | null;
}): MotivationGateDecision {
  const hint = opts.classification.motivation_score_hint ?? null;

  if (!opts.apply) {
    return {
      decision: "skip",
      reason: "not_requested",
      existing_score: opts.existingScore,
      hint,
    };
  }

  if (
    opts.classification.intent !== "motivated" &&
    opts.classification.intent !== "lukewarm"
  ) {
    return {
      decision: "skip",
      reason: "intent_not_motivated_or_lukewarm",
      existing_score: opts.existingScore,
      hint,
    };
  }

  if (hint == null) {
    return {
      decision: "skip",
      reason: "no_hint",
      existing_score: opts.existingScore,
      hint: null,
    };
  }

  if (opts.existingScore != null) {
    // Never stomp an operator-set value (or a prior Sentinel write that
    // hasn't been cleared). Operator's call always wins.
    return {
      decision: "skip",
      reason: "existing_score_set",
      existing_score: opts.existingScore,
      hint,
    };
  }

  return { decision: "apply", score: hint };
}
