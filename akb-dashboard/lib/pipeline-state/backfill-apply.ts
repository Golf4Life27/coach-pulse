// Pipeline_State backfill — pure per-record planner + confirm-token.
// @agent: maverick / orchestrator
//
// Per Spine decision rechGJ32oW9Qmv8wp (builds on verified dry-run
// rec7cYhtOBMWRN1PZ): the gated apply route routes its decisions through
// THIS module before calling the engine. Every guardrail the operator
// locked is enforced here, NOT at the route layer:
//
//   1. Same verified `deriveStageFromLegacy` mapping — no new mapping.
//   2. Blacklist HARD-GUARD via `isNeverResurfaceLoose` — Canon §9
//      twelve addresses can NEVER land in an active stage. If derive
//      proposes anything other than `dead`, override to `dead` with a
//      stable reason code.
//   3. Idempotent — records with `pipelineStage` already populated are
//      skipped here, BEFORE the engine call. (The engine itself
//      short-circuits noop, but pre-filtering saves the round-trip and
//      keeps the audit log clean.)
//   4. Null → derived stage is the initial-assignment seed — the engine
//      handles that path explicitly (`ok_initial_assignment`).
//
// Pure. No I/O.

import { deriveStageFromLegacy, type DerivableListing } from "./derive";
import type { PipelineStage } from "./stages";
import { isNeverResurfaceLoose } from "@/lib/never-resurface";

/** Minimum shape the planner needs per record. Wider than DerivableListing
 *  because it also needs the address (for the blacklist match) + the
 *  recordId (for the audit/engine call). */
export interface BackfillApplyCandidate extends DerivableListing {
  id: string;
  address?: string | null;
}

export type BackfillPlanAction =
  | "apply_derived"            // write the derived stage as initial assignment
  | "apply_blacklist_dead"     // blacklist HARD-GUARD: force to `dead`
  | "skip_already_populated"   // pipelineStage already set → noop (idempotency)
  | "skip_no_address";         // defensive: no address means we can't safely run the guard

export interface BackfillPlan {
  recordId: string;
  address: string | null;
  action: BackfillPlanAction;
  /** The stage that will be WRITTEN to Airtable. null when no write. */
  apply_stage: PipelineStage | null;
  /** What the pure derivation suggested before any override. */
  derived_stage: PipelineStage | null;
  /** Stable reason code for audit + operator review. */
  reason:
    | "already_populated"
    | "no_address_unsafe"
    | "blacklist_hard_guard_override"
    | "derived_clean"
    | "derived_with_conflict";
  message: string;
  /** Conflicts surfaced by the derivation (23-Fields-class). Empty on
   *  clean records. The plan still applies — conflicts are a review
   *  signal, not a stop signal. */
  conflicts: string[];
}

/**
 * Pure: decide what the apply route should do for one record.
 *
 * Order of precedence (most-specific wins):
 *   1. `pipelineStage` already populated → skip (idempotent re-runs).
 *   2. No address at all → skip (can't safely run the blacklist guard).
 *   3. Run `deriveStageFromLegacy` to get the proposed stage.
 *   4. If the address matches the never-resurface blocklist AND derive
 *      proposed any non-`dead` stage → OVERRIDE to `dead` with
 *      `blacklist_hard_guard_override` reason. Canon §9.
 *   5. Otherwise → apply the derived stage.
 */
export function planBackfillRecord(
  l: BackfillApplyCandidate,
): BackfillPlan {
  // 1. Idempotency short-circuit.
  if (l.pipelineStage && l.pipelineStage.trim() !== "") {
    return {
      recordId: l.id,
      address: l.address ?? null,
      action: "skip_already_populated",
      apply_stage: null,
      derived_stage: null,
      reason: "already_populated",
      message: `pipelineStage="${l.pipelineStage}" already set — skip (never clobber engine-set values)`,
      conflicts: [],
    };
  }

  // 2. Defensive: skip records with no address (can't run blacklist guard).
  //    Real intake always carries an address; this branch only fires on
  //    malformed/legacy rows.
  const address = l.address ?? null;
  if (!address || address.trim() === "") {
    return {
      recordId: l.id,
      address,
      action: "skip_no_address",
      apply_stage: null,
      derived_stage: null,
      reason: "no_address_unsafe",
      message: "address missing — refuse to backfill (cannot run never-resurface guard safely)",
      conflicts: [],
    };
  }

  // 3. Derive the proposed stage from the legacy tangle.
  const derivation = deriveStageFromLegacy(l);
  const derived = derivation.stage;

  // 4. Blacklist HARD-GUARD — Canon §9 + decision rechGJ32oW9Qmv8wp.
  //    If the address is on the never-resurface list AND derive proposed
  //    anything OTHER than `dead`, force to `dead`. Enforced in code so
  //    no future data-only error can land a blacklisted address in an
  //    active stage.
  if (derived !== "dead" && isNeverResurfaceLoose(address)) {
    return {
      recordId: l.id,
      address,
      action: "apply_blacklist_dead",
      apply_stage: "dead",
      derived_stage: derived,
      reason: "blacklist_hard_guard_override",
      message: `address matches never-resurface blocklist (Canon §9); derived "${derived}" overridden to "dead"`,
      conflicts: derivation.conflicts,
    };
  }

  // 5. Apply the derivation verbatim.
  return {
    recordId: l.id,
    address,
    action: "apply_derived",
    apply_stage: derived,
    derived_stage: derived,
    reason: derivation.conflicts.length > 0 ? "derived_with_conflict" : "derived_clean",
    message: derivation.message,
    conflicts: derivation.conflicts,
  };
}

/** Stable confirm-token format: `BACKFILL-PIPELINE-STATE-YYYY-MM-DD` (UTC).
 *  Built so it changes every day (replay protection) and so the operator
 *  is forced to type today's date — a meaningful gesture vs a copy-paste
 *  habit. Used by the route to gate writes. */
export function expectedConfirmToken(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `BACKFILL-PIPELINE-STATE-${y}-${m}-${d}`;
}

/** Pure: constant-time-ish compare for the confirm token. The token is not
 *  a secret (it's reproducible from the date), but timing leaks aren't
 *  helpful anywhere — keep it boring. */
export function confirmTokenMatches(
  supplied: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const expected = expectedConfirmToken(now);
  if (!supplied || typeof supplied !== "string") return false;
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  }
  return diff === 0;
}
