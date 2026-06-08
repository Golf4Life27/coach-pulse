// Phase 14 / O — Pulse self-monitoring types.
//
// Pulse watches the rest of the system (Phase 4 math, Phase 13
// Sentinel, Phase 16 backfill, etc.) and surfaces anomalies before
// they compound. Same architectural posture as the other named-agent
// rooms — Pulse is observability, not action. No auto-remediation.
//
// Severity maps to the existing Phase 9.5 tier visual treatment in
// lib/maverick/severity:
//   info     → tier 1 (emerald, "Needs eyes")
//   warning  → tier 2 (orange, "Priority")
//   critical → tier 3 (red,    "Critical")
// Tier 0 ("Watching") is reserved for routine state — never used as a
// Pulse detection (a detection by definition needs eyes).

export type PulseSeverity = "info" | "warning" | "critical";

/** Stable detector IDs. Each maps to one anomaly category Pulse
 *  watches. New detectors get added here; the union doubles as a
 *  compile-time enumeration so the active-set store + UI key off
 *  the same string set. */
export type PulseDetectorId =
  | "token_burn_24h"
  | "cron_cycle_silent"
  | "spine_write_rate_low"
  | "test_count_regression"
  | "endpoint_error_rate_high"
  | "stale_data_drift"
  | "voice_drift"
  | "outreach_volume_drop"
  | "quo_quota_burn"
  | "verification_url_coverage"
  | "paid_api_spend_24h";

export interface PulseDetection {
  /** Unique per-detection-fire ID; for steady-state detections this
   *  is the detector_id itself (so re-firing the same detection on
   *  subsequent scans is idempotent against the active set). */
  id: string;
  detector_id: PulseDetectorId;
  severity: PulseSeverity;
  /** Phase 14.1 — confidence in the detection, 0-1. Deterministic
   *  threshold detectors return 1.0 (always confident in their
   *  binary fire). LLM-based or pattern-matching detectors return
   *  lower confidence to drive proactive-surfacing gates. Defaults
   *  to 1.0 when omitted — preserves existing detector behavior. */
  confidence?: number;
  /** Single-line headline. Rendered in Pulse room + Maverick load-
   *  state briefing. */
  title: string;
  /** Multi-line context. Includes the specific numbers / records
   *  that drove the detection. Length-capped at 1000 chars by the
   *  runner so audit entries stay bounded. */
  description: string;
  /** Optional human-readable next step. Pulse surfaces but does
   *  not act — this is text for the operator. */
  suggested_action?: string;
  /** ISO 8601 timestamp the detector evaluated to "firing". */
  detected_at: string;
  /** Source data the detector consumed. Helps operator audit the
   *  decision without re-running the detector. Bounded payload. */
  source_data?: Record<string, unknown>;
}

/** Mapping for the rest of the system to consume — UI cards, Spine
 *  attribution, audit-log decision labels. */
export const SEVERITY_TIER: Record<PulseSeverity, 1 | 2 | 3> = {
  info: 1,
  warning: 2,
  critical: 3,
};
