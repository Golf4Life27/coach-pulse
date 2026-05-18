// Phase 14 / O.1 — token-burn detector (closes Phase 20.5 carry-forward).
//
// Counts Anthropic-calling audit events in the last 24h and estimates
// daily spend × per-call cost. Alerts when projected daily cost
// crosses thresholds. Proxy-based — we don't yet capture per-call
// token usage in the audit log, so this estimates from event counts.
//
// Anthropic-calling events (each fires one Claude API call):
//   - jarvis_brief_synthesized      (load-state synthesizer, expensive)
//   - sentinel_classified           (single inbound → classifier)
//   - sentinel_drafted              (classify + draft, two calls)
//   - photo_analyzed                (vision call, expensive)
//   - rehab_calibrated              (vision, expensive)
//   - reply_classified              (legacy regex path, free — excluded)
//
// Per-call cost estimates (env-overridable). These are upper-bound
// conservative — used for budget anomaly detection, not billing.

import type { AuditEntry } from "@/lib/audit-log";
import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const ANTHROPIC_EVENT_COSTS_USD: Record<string, number> = {
  // Synthesizer prompts are large (briefing context). Conservative.
  jarvis_brief_synthesized: 0.08,
  // Sentinel classifier + drafter calls.
  sentinel_classified: 0.02,
  sentinel_drafted: 0.04, // includes both classify + draft round-trips
  // Vision calls are the heaviest per-call.
  photo_analyzed: 0.05,
  rehab_calibrated: 0.05,
};

const DEFAULT_WARNING_USD_24H = 8.0;
const DEFAULT_CRITICAL_USD_24H = 20.0;
const HOURS_24_MS = 24 * 3_600_000;

function readUsdThreshold(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Pure: count Anthropic-event firings in the last 24h, by event name. */
export function countAnthropicEventsLast24h(
  audit: AuditEntry[],
  now: Date,
): Record<string, number> {
  const cutoff = now.getTime() - HOURS_24_MS;
  const counts: Record<string, number> = {};
  for (const e of audit) {
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (ANTHROPIC_EVENT_COSTS_USD[e.event] != null) {
      counts[e.event] = (counts[e.event] ?? 0) + 1;
    }
  }
  return counts;
}

/** Pure: project the 24h dollar burn from event counts × per-event
 *  cost estimate. */
export function estimateTokenBurnUsd24h(counts: Record<string, number>): number {
  let total = 0;
  for (const [evt, n] of Object.entries(counts)) {
    const per = ANTHROPIC_EVENT_COSTS_USD[evt];
    if (per == null) continue;
    total += per * n;
  }
  return Math.round(total * 100) / 100; // 2dp
}

export function detectTokenBurn(input: PulseDetectorInput): PulseDetection[] {
  const counts = countAnthropicEventsLast24h(input.audit_log, input.now());
  const estimateUsd = estimateTokenBurnUsd24h(counts);
  const warning = readUsdThreshold(input.env, "PULSE_TOKEN_BURN_WARNING_USD", DEFAULT_WARNING_USD_24H);
  const critical = readUsdThreshold(input.env, "PULSE_TOKEN_BURN_CRITICAL_USD", DEFAULT_CRITICAL_USD_24H);

  if (estimateUsd < warning) return [];

  const severity = estimateUsd >= critical ? "critical" : "warning";
  return [
    {
      id: "token_burn_24h",
      detector_id: "token_burn_24h",
      severity,
      title: `Token burn $${estimateUsd.toFixed(2)} in 24h (${severity} ≥ $${(severity === "critical" ? critical : warning).toFixed(2)})`,
      description: [
        `Estimated 24h Anthropic spend: $${estimateUsd.toFixed(2)}.`,
        `Event counts: ${Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "(none)"}.`,
        `Thresholds: warning $${warning.toFixed(2)} / critical $${critical.toFixed(2)} (env-overridable).`,
      ].join(" "),
      suggested_action:
        severity === "critical"
          ? "Investigate which agent is hot: spike on photo_analyzed / rehab_calibrated suggests a backfill loop; spike on sentinel_drafted suggests Pulse-room over-use. Pause the offending sweep if cost is unexpected."
          : "Watch for the next scan. If burn continues climbing, identify the hot event and decide whether to throttle.",
      detected_at: input.now().toISOString(),
      source_data: {
        estimate_usd: estimateUsd,
        event_counts: counts,
        warning_threshold_usd: warning,
        critical_threshold_usd: critical,
        cost_table: ANTHROPIC_EVENT_COSTS_USD,
      },
    },
  ];
}
