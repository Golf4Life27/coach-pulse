// Pipeline_Stage → DealStage mapping.
// @agent: maverick / orchestrator
//
// Per Spine recUS0oHqXLtEM3lG (V1 build authorization, Track B):
// re-point DealStage consumers to read `Pipeline_Stage` as the source
// of truth. This module is the pure mapping.
//
// `DealStage` is the dashboard's display-layer enum, narrower than
// the 13-value `Pipeline_Stage` lifecycle. The mapping below collapses
// non-dashboard stages (intake/verified/priced) onto `cold`, and the
// terminal stages collapse onto their natural display values.
//
// Engine stays sole writer of Pipeline_Stage — this module is read-
// path only.

import type { DealStage } from "@/types/jarvis";
import { isPipelineStage, type PipelineStage } from "./stages";

/**
 * Pure: map a `Pipeline_Stage` value (or unknown/empty) to a `DealStage`.
 * Returns `null` when the input isn't a recognized PipelineStage value
 * (e.g. empty string, whitespace, garbage) — caller can then fall back
 * to legacy outreachStatus-derived logic.
 */
export function pipelineStageToDealStage(
  stage: string | null | undefined,
): DealStage | null {
  if (!stage) return null;
  const trimmed = stage.trim();
  if (trimmed === "") return null;
  if (!isPipelineStage(trimmed)) return null;
  return STAGE_TO_DEAL_STAGE[trimmed as PipelineStage];
}

/**
 * Static map from PipelineStage → DealStage. Kept inline (not derived)
 * so any future addition to the PipelineStage union surfaces as a TS
 * exhaustiveness error here, forcing an explicit decision rather than
 * a silent default.
 */
const STAGE_TO_DEAL_STAGE: Record<PipelineStage, DealStage> = {
  // Pre-outreach stages → cold (operator hasn't engaged yet).
  intake: "cold",
  verified: "cold",
  priced: "cold",
  outreach_ready: "cold",

  // First-touch / waiting on agent reply.
  outreach_sent: "outreach",

  // Agent replied, not yet engaged.
  responded: "engaged",

  // Mid-negotiation.
  negotiating: "negotiating",

  // Offer drafted, awaiting PA execution.
  offer_drafted: "accepted_pending_pa",

  // Under contract.
  under_contract: "pa_signed",

  // Dispo-side stages collapse into the closing/won view — the
  // dashboard's DealStage enum doesn't model dispo separately yet.
  dispo_active: "closing",
  assignment_signed: "closing",
  closed: "won",

  // Terminal failure.
  dead: "dead",
};
