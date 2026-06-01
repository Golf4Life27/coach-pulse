// Pipeline_State — legal-transition rules.
// @agent: orchestrator / maverick
//
// Per spec §4. Forward, one step at a time, each gated by the
// orchestrator. Plus the kill edge (any non-terminal → dead) and the
// resurrection edge (dead → responded | negotiating).
//
// This module is PURE. It does not write Airtable, does not audit,
// does not know about the engine — it only answers "is this edge
// legal?" `engine.ts` enforces it before writing.

import {
  ALL_PIPELINE_STAGES,
  TERMINAL_STAGES,
  type PipelineStage,
} from "./stages";

/**
 * Forward-edge map. Each non-terminal stage points to the set of
 * stages reachable via the standard one-step-forward transition.
 *
 * Derived from `ALL_PIPELINE_STAGES` array order (each stage's
 * single forward successor is the next array entry, except `closed`
 * which is terminal). Hand-extending FORWARD_NEXT[stage] is the
 * extension point for any future fork (e.g., an `engaged` branch
 * off `responded`); keep that surface explicit rather than implicit
 * so the legal model stays auditable.
 */
export const FORWARD_NEXT: Readonly<Record<PipelineStage, readonly PipelineStage[]>> = (() => {
  const map = {} as Record<PipelineStage, PipelineStage[]>;
  const forward = ALL_PIPELINE_STAGES.filter((s) => s !== "dead");
  forward.forEach((s, i) => {
    const next = forward[i + 1];
    map[s] = next ? [next] : [];
  });
  map["dead"] = []; // forward closed; resurrection handled by opts.resurrection
  return map;
})();

/** Stages a dead record may resurrect into on a fresh inbound. (Spec §4.) */
export const RESURRECTION_TARGETS: ReadonlySet<PipelineStage> = new Set([
  "responded",
  "negotiating",
]);

export interface LegalityOpts {
  /** Set true when transitioning out of `dead` on a fresh inbound. */
  resurrection?: boolean;
}

export interface LegalityResult {
  legal: boolean;
  /** Stable machine-readable reason for the verdict (success or refusal). */
  reason:
    | "ok_initial_assignment"
    | "ok_forward_one_step"
    | "ok_kill_edge"
    | "ok_resurrection"
    | "ok_noop"
    | "illegal_unknown_stage"
    | "illegal_from_terminal_without_resurrection"
    | "illegal_resurrection_target"
    | "illegal_skip_forward"
    | "illegal_backward"
    | "illegal_self_loop_not_noop";
  /** Human-readable explanation (for audit + UI). */
  message: string;
}

/**
 * Pure: is `from → to` a legal transition?
 *
 * Rules (spec §4):
 *   - `null → <any>`: initial assignment — always legal.
 *   - `<non-terminal X> → X`: no-op — legal (engine returns without writing).
 *   - Forward one step per FORWARD_NEXT.
 *   - `<any non-terminal> → dead`: kill edge — always legal.
 *   - `dead → responded | negotiating` when opts.resurrection — legal.
 *   - Everything else: illegal.
 *
 * No I/O. Returns a structured verdict so the engine can audit the
 * refusal reason without re-running the rules.
 */
export function isLegalTransition(
  from: PipelineStage | null,
  to: PipelineStage,
  opts: LegalityOpts = {},
): LegalityResult {
  if (!(ALL_PIPELINE_STAGES as readonly string[]).includes(to)) {
    return {
      legal: false,
      reason: "illegal_unknown_stage",
      message: `target stage "${to}" is not a valid PipelineStage`,
    };
  }

  // Initial assignment — anything goes.
  if (from === null) {
    return {
      legal: true,
      reason: "ok_initial_assignment",
      message: `initial assignment to ${to}`,
    };
  }

  // Self-loop = noop (engine short-circuits).
  if (from === to) {
    return {
      legal: true,
      reason: "ok_noop",
      message: `noop: already at ${to}`,
    };
  }

  // Kill edge: any non-terminal → dead.
  if (to === "dead") {
    if (TERMINAL_STAGES.has(from)) {
      return {
        legal: false,
        reason: "illegal_from_terminal_without_resurrection",
        message: `cannot kill from terminal stage "${from}"`,
      };
    }
    return {
      legal: true,
      reason: "ok_kill_edge",
      message: `kill: ${from} → dead`,
    };
  }

  // Resurrection: dead → responded | negotiating with opts flag.
  if (from === "dead") {
    if (!opts.resurrection) {
      return {
        legal: false,
        reason: "illegal_from_terminal_without_resurrection",
        message: `cannot transition out of terminal "dead" without resurrection flag`,
      };
    }
    if (!RESURRECTION_TARGETS.has(to)) {
      return {
        legal: false,
        reason: "illegal_resurrection_target",
        message: `resurrection target must be one of ${[...RESURRECTION_TARGETS].join("|")}, got "${to}"`,
      };
    }
    return {
      legal: true,
      reason: "ok_resurrection",
      message: `resurrection: dead → ${to}`,
    };
  }

  // `closed` is terminal-success. No forward.
  if (from === "closed") {
    return {
      legal: false,
      reason: "illegal_from_terminal_without_resurrection",
      message: `cannot transition out of terminal "closed"`,
    };
  }

  // Forward one step.
  const legalForward = FORWARD_NEXT[from];
  if (legalForward.includes(to)) {
    return {
      legal: true,
      reason: "ok_forward_one_step",
      message: `forward: ${from} → ${to}`,
    };
  }

  // Diagnose the refusal so audit/UI gets a precise reason.
  const fromOrd = orderOf(from);
  const toOrd = orderOf(to);
  if (toOrd > fromOrd + 1) {
    return {
      legal: false,
      reason: "illegal_skip_forward",
      message: `cannot skip from "${from}" to "${to}" (must step through ${legalForward.join("|") || "—"}); use override + a per-step justification to bypass`,
    };
  }
  return {
    legal: false,
    reason: "illegal_backward",
    message: `cannot move backward from "${from}" to "${to}"`,
  };
}

/** Convenience for UI: stages reachable from `from` via legal one-step transitions
 *  (forward + kill + resurrection if applicable). */
export function nextStages(
  from: PipelineStage | null,
  opts: LegalityOpts = {},
): PipelineStage[] {
  if (from === null) {
    return [...ALL_PIPELINE_STAGES]; // initial assignment is unconstrained
  }
  const out: PipelineStage[] = [];
  if (from === "dead") {
    if (opts.resurrection) {
      for (const t of RESURRECTION_TARGETS) out.push(t);
    }
    return out;
  }
  if (from === "closed") return out;
  out.push(...FORWARD_NEXT[from]);
  out.push("dead");
  return out;
}

function orderOf(s: PipelineStage): number {
  // Local copy to avoid the circular import; STAGE_ORDER lives in stages.ts
  // but we only need ordinals for diagnosis here. Re-derive on demand.
  const i = ALL_PIPELINE_STAGES.indexOf(s);
  return i < 0 ? -1 : i;
}
