// Phase 14 / O.1 — test-count-regression detector.
//
// Catches accidental test deletion: when the current test_count
// (from the prebuild artifact) drops below the previously-recorded
// anchor, fire a warning. The active-detection store retains the
// previous anchor across scans; the runner refreshes it after a
// successful evaluation.
//
// Tolerance: a single-test drop can be intentional (consolidating
// flaky tests). Default fires on drops ≥ 3 tests; configurable via
// env. Drops ≥ 10 escalate to critical (likely whole-file deletion).

import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_WARNING_DROP = 3;
const DEFAULT_CRITICAL_DROP = 10;

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

export function detectTestCountRegression(input: PulseDetectorInput): PulseDetection[] {
  if (input.test_count == null) {
    // Graceful degradation when the prebuild artifact is missing.
    // We don't fire — better to be silent than alarm-fatigue the
    // operator when they're running locally without the artifact.
    return [];
  }
  if (input.previous_test_count == null) {
    // First-scan baseline: nothing to compare against yet. The runner
    // will set the anchor after this scan completes.
    return [];
  }
  if (input.test_count >= input.previous_test_count) return [];

  const drop = input.previous_test_count - input.test_count;
  const warningDrop = readIntThreshold(input.env, "PULSE_TEST_DROP_WARNING", DEFAULT_WARNING_DROP);
  const criticalDrop = readIntThreshold(input.env, "PULSE_TEST_DROP_CRITICAL", DEFAULT_CRITICAL_DROP);

  if (drop < warningDrop) {
    // Below warning threshold — silent (small drops are normal).
    return [];
  }

  const severity = drop >= criticalDrop ? "critical" : "warning";
  return [
    {
      id: "test_count_regression",
      detector_id: "test_count_regression",
      severity,
      title: `Test count dropped ${drop} (was ${input.previous_test_count}, now ${input.test_count})`,
      description: `Prebuild test-count artifact reports ${input.test_count} tests; previous Pulse-anchored count was ${input.previous_test_count}. Drops of ≥${criticalDrop} usually mean a whole test file was deleted or excluded; drops of ${warningDrop}-${criticalDrop - 1} can be intentional consolidation. Verify the drop is intentional.`,
      suggested_action: "git diff against the prior commit's lib/maverick/data/test-counts.json (or scripts/gen-test-count output) to confirm which test file(s) shrank.",
      detected_at: input.now().toISOString(),
      source_data: {
        current_count: input.test_count,
        previous_count: input.previous_test_count,
        drop,
        warning_threshold: warningDrop,
        critical_threshold: criticalDrop,
      },
    },
  ];
}
