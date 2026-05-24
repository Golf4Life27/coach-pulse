// Phase 14.2 / Q.2 — outreach-volume-drop detector.
//
// Drift detector: compares current 24h outbound-send count against
// the prior 24-72h window. Fires when current is materially below
// historical baseline. Catches: Quo API down silently, Cadence_Queue
// frozen, Sentry blocking everything, etc. — failure modes where the
// system is "up" but no work is happening.

import type { AuditEntry } from "@/lib/audit-log";
import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const SEND_EVENTS = new Set([
  "send_attempt",      // gmail + quo
  "crier_reply_drafted", // sentinel-via-synthesizer
  "scout_outreach_drafted",
  "scout_warmup_drafted",
]);

const DEFAULT_WARNING_DROP_PCT = 0.5; // 50% drop
const DEFAULT_CRITICAL_DROP_PCT = 0.8; // 80% drop
const DEFAULT_MIN_HISTORICAL = 10; // need ≥10 historical sends to trust the comparison

function readPctThreshold(
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

/** Pure: count outbound-send audit events in a window. */
export function countSendsInWindow(
  audit: AuditEntry[],
  windowStart: number,
  windowEnd: number,
): number {
  let n = 0;
  for (const e of audit) {
    if (!SEND_EVENTS.has(e.event)) continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < windowStart || t >= windowEnd) continue;
    n++;
  }
  return n;
}

export function detectOutreachVolumeDrop(input: PulseDetectorInput): PulseDetection[] {
  const now = input.now().getTime();
  const current24h = countSendsInWindow(input.audit_log, now - 24 * 3_600_000, now);
  const prior48h = countSendsInWindow(input.audit_log, now - 72 * 3_600_000, now - 24 * 3_600_000);
  // Normalize prior to per-24h rate (it's a 48-hour window).
  const priorPer24h = prior48h / 2;

  const minHistorical = readIntThreshold(input.env, "PULSE_OUTREACH_DROP_MIN_HISTORICAL", DEFAULT_MIN_HISTORICAL);
  if (priorPer24h < minHistorical) {
    // Not enough historical data to trust the comparison.
    return [];
  }

  const warningPct = readPctThreshold(input.env, "PULSE_OUTREACH_DROP_WARNING_PCT", DEFAULT_WARNING_DROP_PCT);
  const criticalPct = readPctThreshold(input.env, "PULSE_OUTREACH_DROP_CRITICAL_PCT", DEFAULT_CRITICAL_DROP_PCT);

  const dropPct = 1 - current24h / priorPer24h;
  if (dropPct < warningPct) return [];

  const severity = dropPct >= criticalPct ? "critical" : "warning";
  return [
    {
      id: "outreach_volume_drop",
      detector_id: "outreach_volume_drop",
      severity,
      // Pattern-detection (not threshold) — confidence reflects the
      // statistical strength of a 24h-window comparison.
      confidence: priorPer24h >= 30 ? 0.9 : 0.7,
      title: `Outreach volume dropped ${Math.round(dropPct * 100)}% (current 24h ${current24h} vs prior-24h avg ${Math.round(priorPer24h)})`,
      description: `Outbound-send activity has fallen materially. Current 24h: ${current24h} send events. Prior 48h normalized to 24h: ${priorPer24h.toFixed(1)}. Likely causes: Quo API down silently, Cadence_Queue frozen, Sentry blocking everything, cron stalled, or pipeline genuinely quieter (operator weekend).`,
      suggested_action:
        severity === "critical"
          ? "Check Quo dashboard + recent send_attempt audit failures via /api/admin/audit-summary. Confirm crons fired this morning."
          : "Verify Quo is responsive and recent sends landed. If volumes were intentionally quieter, dismiss.",
      detected_at: input.now().toISOString(),
      source_data: {
        current_24h: current24h,
        prior_48h_normalized: Math.round(priorPer24h * 10) / 10,
        drop_pct: Math.round(dropPct * 1000) / 1000,
        warning_pct: warningPct,
        critical_pct: criticalPct,
        min_historical: minHistorical,
      },
    },
  ];
}
