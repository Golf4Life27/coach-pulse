// V21 contract-authorization gate (keystone 2026-06-13, spine
// recUA3woaBnF5SBK5, Maverick ruling A-prime #2/#3). @agent: orchestrator
//
// THE ENFORCEMENT POINT. A provisional V21 (landlord classification
// resting on vision-only redflags, null distressScore) WRITES a number
// but cannot AUTHORIZE a contract/autonomous send until the DD loop
// corroborates the as-is condition with the agent. Any contract-pricing
// path that would use Your_MAO_V21 to authorize a committed offer MUST
// call this gate first.
//
// Corroboration logic (from the DD mechanical-age signals the agent
// answered — lib/dd-rehab-signals):
//   - Agent confirms as-is (any mechanical original_pre1980) → the vision
//     distress flag is corroborated → PROMOTE → authorized.
//   - Agent says renovated (mechanicals answered, all updated_post1980)
//     → the vision flag was noise → CONTRADICTED → fall back to flipper,
//     no contract number authorized on a hallucination.
//   - DD not yet answered → PENDING → not authorized; route to DD.
//
// A non-provisional (scoreBacked) landlord V21 authorizes immediately.
// A null V21 never authorizes (no number).

import type { DDRehabSignals } from "@/lib/dd-rehab-signals";
import type { V21Lane } from "@/lib/v21-writer-decision";

export type V21AuthVerdict =
  | { authorized: true; basis: "scored_distress" | "provisional_dd_corroborated" }
  | { authorized: false; reason: "no_v21_number" | "provisional_dd_pending" | "provisional_contradicted_renovated"; detail: string };

export interface V21AuthInput {
  /** Your_MAO_V21 value (null = no number). */
  v21Value: number | null | undefined;
  /** Lane from the writer marker / decision. */
  lane: V21Lane | null | undefined;
  /** DD mechanical-age signals (lib/dd-rehab-signals.extractDDRehabSignals).
   *  Pass null/zeroed when no DD collected yet. */
  ddSignals: DDRehabSignals;
}

const MECHS = ["roof", "hvac", "waterHeater", "electrical", "plumbing"] as const;

export function evaluateV21ContractAuthorization(input: V21AuthInput): V21AuthVerdict {
  const v21 = typeof input.v21Value === "number" && Number.isFinite(input.v21Value) && input.v21Value > 0 ? input.v21Value : null;
  if (v21 == null) {
    return { authorized: false, reason: "no_v21_number", detail: "Your_MAO_V21 is null/≤0 — no contract number to authorize" };
  }

  // Scored (non-provisional) landlord → authorized immediately.
  if (input.lane !== "landlord_provisional") {
    return { authorized: true, basis: "scored_distress" };
  }

  // Provisional → needs DD corroboration of the as-is condition.
  const s = input.ddSignals;
  const answered = MECHS.filter((m) => s[m].bucket !== "unknown");
  if (answered.length === 0) {
    return {
      authorized: false,
      reason: "provisional_dd_pending",
      detail: "provisional V21 (vision-only distress) — no DD answers yet; route to DD, agent must corroborate the condition before this number authorizes a contract",
    };
  }
  const anyOriginal = answered.some((m) => s[m].bucket === "original_pre1980");
  if (anyOriginal) {
    return { authorized: true, basis: "provisional_dd_corroborated" };
  }
  // All answered mechanicals are updated → renovated → vision flag was noise.
  return {
    authorized: false,
    reason: "provisional_contradicted_renovated",
    detail: `provisional V21 CONTRADICTED — agent reports ${answered.length}/5 mechanicals updated (renovated); the vision distress flag was noise. Falls back to flipper — no contract number authorized on a hallucination.`,
  };
}
