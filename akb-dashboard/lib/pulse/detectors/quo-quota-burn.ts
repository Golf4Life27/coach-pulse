// Phase 14.3 / Q.2 — Quo quota burn detector.
//
// Counts quo send_attempt audit events in last 24h and alerts when
// daily volume crosses operator-configurable thresholds. Quo doesn't
// expose a "calls remaining" API; this is the practical equivalent
// — operator sets the daily limit they want to stay under, Pulse
// surfaces when we're approaching it.

import type { AuditEntry } from "@/lib/audit-log";
import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_DAILY_LIMIT = 500;       // operator-defined daily ceiling
const DEFAULT_WARNING_PCT = 0.7;       // 70% of daily limit
const DEFAULT_CRITICAL_PCT = 0.9;      // 90% of daily limit

function readInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function readPct(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

/** Pure: count quo send_attempt events in last 24h. */
export function countQuoSendsLast24h(audit: AuditEntry[], now: Date): number {
  const cutoff = now.getTime() - 24 * 3_600_000;
  let n = 0;
  for (const e of audit) {
    if (e.agent !== "quo" || e.event !== "send_attempt") continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    n++;
  }
  return n;
}

export function detectQuoQuotaBurn(input: PulseDetectorInput): PulseDetection[] {
  const dailyLimit = readInt(input.env, "PULSE_QUO_DAILY_LIMIT", DEFAULT_DAILY_LIMIT);
  if (dailyLimit <= 0) return []; // disabled
  const warningPct = readPct(input.env, "PULSE_QUO_WARNING_PCT", DEFAULT_WARNING_PCT);
  const criticalPct = readPct(input.env, "PULSE_QUO_CRITICAL_PCT", DEFAULT_CRITICAL_PCT);

  const count = countQuoSendsLast24h(input.audit_log, input.now());
  const usagePct = count / dailyLimit;
  if (usagePct < warningPct) return [];

  const severity = usagePct >= criticalPct ? "critical" : "warning";
  return [
    {
      id: "quo_quota_burn",
      detector_id: "quo_quota_burn",
      severity,
      title: `Quo at ${Math.round(usagePct * 100)}% of daily limit (${count}/${dailyLimit} sends)`,
      description: `Quo send_attempt events in last 24h: ${count}. Operator-configured daily limit: ${dailyLimit} (PULSE_QUO_DAILY_LIMIT). At ${Math.round(usagePct * 100)}% of cap. Crier may pause sends if cap exceeded to avoid carrier throttle / Quo API rate limits.`,
      suggested_action:
        severity === "critical"
          ? "Pause non-essential cron sends until tomorrow. Confirm carrier-side A2P 10DLC isn't throttling. Bump PULSE_QUO_DAILY_LIMIT if the cap was set too low."
          : "Monitor send rate today. If trajectory keeps climbing, throttle non-time-sensitive cadence cycles.",
      detected_at: input.now().toISOString(),
      source_data: {
        sends_24h: count,
        daily_limit: dailyLimit,
        usage_pct: Math.round(usagePct * 1000) / 1000,
        warning_pct: warningPct,
        critical_pct: criticalPct,
      },
    },
  ];
}
