// Phase 14 / O.1 — cron-cycle-silent detector.
//
// The cron routes themselves don't write audit events at the top
// level (verified via grep on 5/18); they only audit downstream
// effects (Quo sends, Airtable writes, etc.). So this detector uses
// "any agent activity in last X hours" as the heartbeat proxy —
// a fully silent audit log for > expected_silence_hours signals a
// stalled cron cycle.
//
// Tighter per-cron detection (e.g., "scan-comms didn't fire this
// morning") can layer on later once each cron writes an explicit
// cron_fired audit entry. Tracked as a future refinement; out of
// scope for O.1's pragmatic landing.

import type { AuditEntry } from "@/lib/audit-log";
import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_WARNING_SILENCE_HOURS = 36;
const DEFAULT_CRITICAL_SILENCE_HOURS = 72;

function readHoursThreshold(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Pure: hours since the most-recent audit event (any agent). Null
 *  when audit log is empty (treated as critical separately). */
export function hoursSinceMostRecentAuditEvent(
  audit: AuditEntry[],
  now: Date,
): number | null {
  if (audit.length === 0) return null;
  // Audit log is newest-first (per readRecentFromKv), but defensive:
  // scan for the max ts in case ordering is unstable.
  let newest = 0;
  for (const e of audit) {
    const t = new Date(e.ts).getTime();
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  if (newest === 0) return null;
  return Math.max(0, (now.getTime() - newest) / 3_600_000);
}

export function detectCronCycleSilent(input: PulseDetectorInput): PulseDetection[] {
  const hours = hoursSinceMostRecentAuditEvent(input.audit_log, input.now());
  const warning = readHoursThreshold(input.env, "PULSE_CRON_SILENCE_WARNING_HOURS", DEFAULT_WARNING_SILENCE_HOURS);
  const critical = readHoursThreshold(input.env, "PULSE_CRON_SILENCE_CRITICAL_HOURS", DEFAULT_CRITICAL_SILENCE_HOURS);

  if (hours == null) {
    // Empty audit log — likely fresh KV or KV unavailable. Fire info,
    // not critical, since this is also the dev-mode happy path.
    return [
      {
        id: "cron_cycle_silent",
        detector_id: "cron_cycle_silent",
        severity: "info",
        title: "Audit log empty — Pulse can't measure cron cadence",
        description:
          "readRecentFromKv returned zero events. Either Vercel KV is not yet wired (dev mode in-memory ring is volatile across lambda restarts), or the cycle has produced no events in the retention window. Investigate KV health before relying on other Pulse detectors.",
        suggested_action: "Confirm KV_REST_API_URL + KV_REST_API_TOKEN env vars are set. Hit /api/admin/audit-summary to see if events are flowing.",
        detected_at: input.now().toISOString(),
        source_data: { hours_since_latest: null, audit_log_size: 0 },
      },
    ];
  }
  if (hours < warning) return [];

  const severity = hours >= critical ? "critical" : "warning";
  return [
    {
      id: "cron_cycle_silent",
      detector_id: "cron_cycle_silent",
      severity,
      title: `Audit log silent ${Math.round(hours)}h (${severity} ≥ ${severity === "critical" ? critical : warning}h)`,
      description: `Most-recent audit event is ${Math.round(hours)}h old. Expected daily-cron cycle produces multiple events per 24h. Likely causes: cron scheduler paused, lambdas failing on cold start, or KV write path broken.`,
      suggested_action:
        severity === "critical"
          ? "Vercel cron status check + tail recent deploy logs. Try a manual fire of /api/cron/propose-actions to see if it lands an audit event."
          : "Watch the next scan. If cron-cycle stays silent, escalate to critical investigation.",
      detected_at: input.now().toISOString(),
      source_data: {
        hours_since_latest: Math.round(hours * 10) / 10,
        warning_threshold_hours: warning,
        critical_threshold_hours: critical,
        audit_log_size: input.audit_log.length,
      },
    },
  ];
}
