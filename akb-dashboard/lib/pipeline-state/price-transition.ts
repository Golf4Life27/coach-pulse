// Pipeline_State — the `priced` writer (M7 Part 1, operator 2026-06-18).
// @agent: maverick / orchestrator
//
// THE MISSING WRITER. The canonical lifecycle (stages.ts) is
//   intake → verified → priced → outreach_ready → …
// but until now NOTHING ever wrote `priced`: no gate targets it, the
// legacy-derive never emits it, and the intake/autoseed opener-write set
// Rough_Opener_Amount without advancing the stage. Result: `priced` was a
// phantom stage (live census: 0 records), and because the legal-edge guard
// enforces strict forward-one-step, the only legal predecessor of
// `outreach_ready` is `priced` — so a genuinely-`verified` record could
// never advance through Gate 1 (the engine refused verified→outreach_ready
// as illegal_skip_forward). The belt was severed at verified→priced→ready.
//
// This module closes the gap WITHOUT weakening the locked engine: the
// pricing event (an opener was written) IS the `priced` checkpoint. We route
// the stage write through `transitionStage` (THE SOLE WRITER) so the
// legal-edge guard + audit trail stay intact. We never force an illegal
// edge — an unexpected current stage is surfaced by the engine and handled
// fail-closed by the caller (the record simply stays put, never silent-
// forwarded).
//
// Legal predecessors of `priced` (transitions.ts FORWARD_NEXT):
//   - null      → ok_initial_assignment  (fresh intake born priced)
//   - "verified"→ ok_forward_one_step
//   - "priced"  → ok_noop                (idempotent re-price)
// Anything else (e.g. "intake" without a verify step) is refused by the
// engine as illegal_skip_forward — returned, never written.

import { transitionStage, type TransitionDeps, type TransitionResult } from "./engine";
import type { PipelineStage } from "./stages";

/**
 * Advance a record to `priced` because its opener was just written.
 *
 * Pure delegation to the sole-writer engine — no new write surface. The
 * caller passes the record's pre-known current stage (omit/`null` for a
 * fresh intake record) so the engine does not re-fetch. The result's
 * `outcome` is `applied` (null/verified→priced), `noop` (already priced),
 * or a `rejected_*` the caller must treat fail-closed (do NOT proceed to
 * outreach as if priced).
 */
export async function transitionToPriced(
  recordId: string,
  currentStage: PipelineStage | null,
  reason: string,
  deps: TransitionDeps = {},
): Promise<TransitionResult> {
  return transitionStage(
    {
      recordId,
      to: "priced",
      reason,
      attribution: "maverick",
      triggered_by: "intake",
      current: { pipelineStage: currentStage },
    },
    deps,
  );
}
