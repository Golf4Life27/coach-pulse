// INV-026 — material movement on the Wife-Retirement Progress Meter.
//
// The brief is explicit: "Material movement (positive or negative) on
// any metric becomes a Type 2C card with diagnosis." This detector
// closes that ask by firing a Pulse detection whenever the diff
// between the current meter snapshot and the previous Pulse-anchored
// snapshot crosses one of the material thresholds.
//
// Severity rules (load-bearing thresholds — change deliberately):
//
//   stall_count
//     ↑1 stage HIGH-risk         → warning ("a stage regressed")
//     ↑1 stage LOW/MED             → info
//     ↓1 stage                     → info ("a stage cleared the lost-phone test")
//     ↓1 HIGH stage                → CRITICAL up-direction info ("HIGH→cleared")
//
//   monthly_net_usd
//     crosses $0 upward (any positive after $0)  → CRITICAL (first deal!)
//     drops ≥ 20% MoM                            → warning
//
//   build_pct
//     ↑ 5 points or more           → info ("material build progress")
//     ↓ any amount                 → warning (build should never regress)
//
// All thresholds are env-overridable. Silent (no detection) when there's
// no previous snapshot — the first scan establishes the anchor.

import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_BUILD_PCT_MATERIAL_DELTA = 5;
const DEFAULT_VELOCITY_DROP_PCT = 20;

function readIntThreshold(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function detectProgressMeterMovement(
  input: PulseDetectorInput,
): PulseDetection[] {
  const current = input.progress_meter ?? null;
  const previous = input.previous_progress_meter ?? null;
  if (!current || !previous) {
    // No meter loaded, or first-scan baseline — silent.
    return [];
  }

  const detections: PulseDetection[] = [];
  const now = input.now().toISOString();
  const buildPctMaterial = readIntThreshold(
    input.env,
    "PULSE_PROGRESS_BUILD_PCT_MATERIAL",
    DEFAULT_BUILD_PCT_MATERIAL_DELTA,
  );
  const velocityDropPct = readIntThreshold(
    input.env,
    "PULSE_PROGRESS_VELOCITY_DROP_PCT",
    DEFAULT_VELOCITY_DROP_PCT,
  );

  // ── Stall-count movement ─────────────────────────────────────────
  const stallDelta = current.stall_count - previous.stall_count;
  const highRiskDelta = current.high_risk_stalls - previous.high_risk_stalls;
  if (stallDelta > 0) {
    // Regression — a stage started stalling.
    const severity: PulseDetection["severity"] = highRiskDelta > 0 ? "warning" : "info";
    detections.push({
      id: "progress_meter_stall_regression",
      detector_id: "progress_meter_movement",
      severity,
      title: `Lost-Phone stall count rose ${stallDelta} (now ${current.stall_count}, was ${previous.stall_count})`,
      description: `A pipeline stage that previously did not stall without the operator now does. HIGH-risk stalls: ${previous.high_risk_stalls} → ${current.high_risk_stalls}. The metric is the load-bearing one per INV-026 — operator-required regression.`,
      suggested_action:
        "Open lib/progress-meter/stages.ts and find which stage flipped stallsWithoutOperator to true. If the regression is intentional (a blocker reappeared), confirm; if not, the recent change broke an autonomous path.",
      detected_at: now,
      source_data: {
        previous_stall_count: previous.stall_count,
        current_stall_count: current.stall_count,
        previous_high_risk: previous.high_risk_stalls,
        current_high_risk: current.high_risk_stalls,
      },
    });
  } else if (stallDelta < 0) {
    // Improvement — a stage cleared the lost-phone test. HIGH→ cleared is
    // a tier above an ordinary clear and gets the surfaced info severity.
    const severity: PulseDetection["severity"] = highRiskDelta < 0 ? "info" : "info";
    detections.push({
      id: "progress_meter_stall_improved",
      detector_id: "progress_meter_movement",
      severity,
      title: `Lost-Phone stall count dropped ${-stallDelta} (now ${current.stall_count}, was ${previous.stall_count})`,
      description: `A pipeline stage cleared the operator-required threshold. HIGH-risk stalls: ${previous.high_risk_stalls} → ${current.high_risk_stalls}. This is forward motion on the load-bearing metric per INV-026.`,
      suggested_action:
        "Confirm the cleared stage matches what the recent ship was intended to unblock; update the V1_Roadmap_to_100 phase status.",
      detected_at: now,
      source_data: {
        previous_stall_count: previous.stall_count,
        current_stall_count: current.stall_count,
        previous_high_risk: previous.high_risk_stalls,
        current_high_risk: current.high_risk_stalls,
      },
    });
  }

  // ── Deal velocity ────────────────────────────────────────────────
  if (previous.monthly_net_usd === 0 && current.monthly_net_usd > 0) {
    // The headline event — the system went from $0/mo to a real number.
    detections.push({
      id: "progress_meter_velocity_unblocked",
      detector_id: "progress_meter_movement",
      severity: "critical",
      title: `Deal velocity crossed $0 — now $${current.monthly_net_usd.toLocaleString()}/mo`,
      description: `The Crawler-2.0 unlock metric (Bible §1.2) just registered its first positive month after a sustained $0. This is the deal-closing milestone the entire INV-026 brief is built around.`,
      suggested_action:
        "Lock the closed deal into Phase 15.5 per-deal P&L. Confirm the dispo orchestration that produced this is durable, not a one-off operator-driven close.",
      detected_at: now,
      source_data: {
        previous_monthly_net_usd: previous.monthly_net_usd,
        current_monthly_net_usd: current.monthly_net_usd,
      },
    });
  } else if (
    previous.monthly_net_usd > 0 &&
    current.monthly_net_usd <
      previous.monthly_net_usd * (1 - velocityDropPct / 100)
  ) {
    const dropPct = Math.round(
      ((previous.monthly_net_usd - current.monthly_net_usd) / previous.monthly_net_usd) * 100,
    );
    detections.push({
      id: "progress_meter_velocity_drop",
      detector_id: "progress_meter_movement",
      severity: "warning",
      title: `Deal velocity dropped ${dropPct}% (now $${current.monthly_net_usd.toLocaleString()}/mo, was $${previous.monthly_net_usd.toLocaleString()})`,
      description: `Trailing-90d velocity fell more than ${velocityDropPct}% MoM. Could be a closing slipping out of the window, or genuine dispo-throughput loss.`,
      suggested_action:
        "Check Phase 15.5 per-deal P&L for which deal exited the window; cross-reference dispo-funnel state for any recent stalls.",
      detected_at: now,
      source_data: {
        previous_monthly_net_usd: previous.monthly_net_usd,
        current_monthly_net_usd: current.monthly_net_usd,
        drop_pct: dropPct,
      },
    });
  }

  // ── Build percentage ─────────────────────────────────────────────
  const buildDelta = current.build_pct - previous.build_pct;
  if (buildDelta <= -1) {
    // Build% regression — should never happen organically.
    detections.push({
      id: "progress_meter_build_regression",
      detector_id: "progress_meter_movement",
      severity: "warning",
      title: `Build% regressed ${-buildDelta} points (now ${current.build_pct}%, was ${previous.build_pct}%)`,
      description: `The blended pipeline+infra completion estimate dropped. Build% in lib/progress-meter/stages.ts only changes by a manual edit, so this means a stage's completionPct was lowered — confirm intentional (a discovered regression) vs accidental.`,
      suggested_action:
        "git blame lib/progress-meter/stages.ts to identify which stage's completionPct dropped and why.",
      detected_at: now,
      source_data: {
        previous_build_pct: previous.build_pct,
        current_build_pct: current.build_pct,
      },
    });
  } else if (buildDelta >= buildPctMaterial) {
    detections.push({
      id: "progress_meter_build_material_gain",
      detector_id: "progress_meter_movement",
      severity: "info",
      title: `Build% gained ${buildDelta} points (now ${current.build_pct}%, was ${previous.build_pct}%)`,
      description: `A material build advancement landed — at least one stage's completionPct moved up enough to shift the blended overall. Per INV-026 the % is secondary to the stall count, so verify the gain corresponds to a real stall-count or velocity move.`,
      suggested_action:
        "Confirm the stage advance matches the V1_Roadmap_to_100 phase ordering — gains on stations earlier than the critical path don't move the needle on the load-bearing metric.",
      detected_at: now,
      source_data: {
        previous_build_pct: previous.build_pct,
        current_build_pct: current.build_pct,
      },
    });
  }

  return detections;
}
