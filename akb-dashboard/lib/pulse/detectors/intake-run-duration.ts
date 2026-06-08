// Intake run-duration creep detector (2026-06-08).
//
// The listings-intake cron hit FUNCTION_INVOCATION_TIMEOUT (300s) on a
// 30-ZIP slice. The fix (small per-invocation cap + self-limiting wall-
// clock budget + frequency) makes a timeout structurally impossible, but
// we still want to SEE per-ZIP latency creep BEFORE it forces partial
// runs — if Firecrawl/RentCast slow down, per_zip_avg_ms rises and the
// budget starts cutting runs short. This detector reads the intake
// audit's timing telemetry and alarms on creep toward the ceiling.

import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const MAX_DURATION_MS = 300_000;
// Fire WARNING when the most recent run consumed > this fraction of the
// lambda ceiling; CRITICAL above the higher fraction. Env-overridable.
const DEFAULT_WARN_FRACTION = 0.7; // 210s
const DEFAULT_CRIT_FRACTION = 0.85; // 255s

function readFraction(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

export function detectIntakeRunDuration(
  input: PulseDetectorInput,
): PulseDetection[] {
  // Most-recent intake run (live or dry-run), newest-first audit log.
  const run = input.audit_log.find(
    (e) =>
      (e.event === "listings_intake_live" || e.event === "listings_intake_dry_run") &&
      e.outputSummary != null &&
      typeof (e.outputSummary as { timing?: unknown }).timing === "object",
  );
  if (!run) return [];

  const timing = (run.outputSummary as { timing?: Record<string, unknown> }).timing!;
  const totalMs = Number(timing.total_ms);
  if (!Number.isFinite(totalMs) || totalMs <= 0) return [];

  const warnFraction = readFraction(input.env, "PULSE_INTAKE_DURATION_WARN_FRACTION", DEFAULT_WARN_FRACTION);
  const critFraction = readFraction(input.env, "PULSE_INTAKE_DURATION_CRIT_FRACTION", DEFAULT_CRIT_FRACTION);

  const fraction = totalMs / MAX_DURATION_MS;
  if (fraction < warnFraction) return [];

  const severity: PulseDetection["severity"] = fraction >= critFraction ? "critical" : "warning";
  const perZip = timing.per_zip_avg_ms != null ? Number(timing.per_zip_avg_ms) : null;
  const zips = timing.zips_processed != null ? Number(timing.zips_processed) : null;
  const budgetMs = timing.lambda_budget_ms != null ? Number(timing.lambda_budget_ms) : null;

  return [
    {
      id: "intake_run_duration_creep",
      detector_id: "intake_run_duration",
      severity,
      title: `Intake run used ${Math.round(fraction * 100)}% of the 300s ceiling (${Math.round(totalMs / 1000)}s)`,
      description:
        `The most recent listings-intake run took ${Math.round(totalMs / 1000)}s` +
        `${zips != null ? ` over ${zips} ZIPs` : ""}` +
        `${perZip != null ? ` (~${perZip}ms/ZIP)` : ""}. ` +
        `The self-limiting budget (${budgetMs ?? "?"}ms) prevents an actual timeout, but duration creeping toward ` +
        `the 300s ceiling means per-ZIP latency is rising — runs will start cutting short and leaving more ZIPs due. ` +
        `${severity === "critical" ? "At this level the budget is actively truncating most runs." : ""}`,
      suggested_action:
        "Lower RENTCAST_INTAKE_ZIPS_PER_RUN so each invocation finishes faster (and raise cron frequency to keep coverage), OR investigate the slow phase: compare timing.collect_ms (RentCast) vs timing.verify_ms (Firecrawl) in the intake audit.",
      detected_at: input.now().toISOString(),
      source_data: {
        total_ms: totalMs,
        per_zip_avg_ms: perZip,
        zips_processed: zips,
        fraction_of_ceiling: Number(fraction.toFixed(3)),
        collect_ms: timing.collect_ms ?? null,
        verify_ms: timing.verify_ms ?? null,
        classify_write_ms: timing.classify_write_ms ?? null,
      },
    },
  ];
}
