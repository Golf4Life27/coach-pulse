// Phase 14 / O.1 — spine-write-rate detector.
//
// Catches the Phase 20.7 class of incidents: maverick_write_state
// silently stopped firing for ~14 commits, leaving Spine empty of
// build_events while real code was shipping. Pulse detects this
// gap by counting write_state.* audit events over a rolling window
// and alerting when the rate drops below threshold.
//
// Audit event naming convention from lib/maverick/write-state.ts:
//   `write_state.<event_type>` where event_type ∈ {decision,
//   principle_amendment, build_event, deal_state_change}
//
// Default thresholds assume a working session produces ≥1 Spine
// write per ~4h of activity. A 24h window without ANY write_state
// events is a strong "discipline failure" signal.

import type { AuditEntry } from "@/lib/audit-log";
import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_WARNING_WINDOW_HOURS = 24;
const DEFAULT_WARNING_MIN_WRITES = 1;
const DEFAULT_CRITICAL_WINDOW_HOURS = 48;
const DEFAULT_CRITICAL_MIN_WRITES = 1;

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

/** Pure: count write_state.* audit events within the last `hours`. */
export function countSpineWritesWithin(
  audit: AuditEntry[],
  hours: number,
  now: Date,
): number {
  const cutoff = now.getTime() - hours * 3_600_000;
  let n = 0;
  for (const e of audit) {
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (e.event.startsWith("write_state.")) n++;
  }
  return n;
}

export function detectSpineWriteRate(input: PulseDetectorInput): PulseDetection[] {
  const warningHours = readIntThreshold(input.env, "PULSE_SPINE_WARNING_WINDOW_HOURS", DEFAULT_WARNING_WINDOW_HOURS);
  const warningMin = readIntThreshold(input.env, "PULSE_SPINE_WARNING_MIN", DEFAULT_WARNING_MIN_WRITES);
  const criticalHours = readIntThreshold(input.env, "PULSE_SPINE_CRITICAL_WINDOW_HOURS", DEFAULT_CRITICAL_WINDOW_HOURS);
  const criticalMin = readIntThreshold(input.env, "PULSE_SPINE_CRITICAL_MIN", DEFAULT_CRITICAL_MIN_WRITES);

  const now = input.now();
  const writes24 = countSpineWritesWithin(input.audit_log, warningHours, now);
  const writes48 = countSpineWritesWithin(input.audit_log, criticalHours, now);

  if (writes48 < criticalMin) {
    return [
      {
        id: "spine_write_rate_low",
        detector_id: "spine_write_rate_low",
        severity: "critical",
        title: `Zero Spine writes in last ${criticalHours}h — Phase 20.7-class discipline failure`,
        description: `No maverick_write_state events in the last ${criticalHours}h (${writes48} writes vs minimum ${criticalMin}). This is the silent-discipline-failure signature that triggered the Phase 20.7 incident: real work shipping without Spine entries, which means future Maverick load-state briefings will miss the work.`,
        suggested_action: "Fire maverick_write_state from this session for any commits that landed without a Spine entry. Cross-check git log against recent Spine_Decision_Log rows.",
        detected_at: now.toISOString(),
        source_data: {
          writes_in_window: writes48,
          window_hours: criticalHours,
          critical_min: criticalMin,
        },
      },
    ];
  }

  if (writes24 < warningMin) {
    return [
      {
        id: "spine_write_rate_low",
        detector_id: "spine_write_rate_low",
        severity: "warning",
        title: `${writes24} Spine writes in last ${warningHours}h (expected ≥${warningMin})`,
        description: `Spine write rate is below expected baseline. Some sessions may be skipping the maverick_write_state ritual after each commit. Confirm continuity-layer discipline before drift compounds (Phase 20.7 precedent).`,
        suggested_action: "Review the last few commits — each code commit should have a paired Spine entry. Backfill any missing writes.",
        detected_at: now.toISOString(),
        source_data: {
          writes_in_window: writes24,
          window_hours: warningHours,
          warning_min: warningMin,
        },
      },
    ];
  }

  return [];
}
