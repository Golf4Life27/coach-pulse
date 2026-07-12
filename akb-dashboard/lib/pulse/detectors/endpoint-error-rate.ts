// Phase 14 / O.1 — endpoint-error-rate detector.
//
// Groups confirmed_failure audit events by event name within a
// rolling window and fires per-event when the failure rate exceeds
// threshold. The failure rate is computed as failures / (failures
// + successes) over the window — so a route firing 1 failure out of
// 100 calls doesn't alarm.
//
// Excluded events: ones explicitly known to be transient / external
// (Quo and DocuSign rate-limits, etc.) — operator can tune via
// PULSE_ERROR_RATE_EXCLUDE env (comma-separated event names).

import type { AuditEntry } from "@/lib/audit-log";
import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_MIN_SAMPLES = 5; // need at least this many calls to trust the rate
const DEFAULT_WARNING_RATE = 0.25;
const DEFAULT_CRITICAL_RATE = 0.5;

function readWindow(env: Record<string, string | undefined>): number {
  const raw = env.PULSE_ERROR_WINDOW_HOURS;
  if (!raw) return DEFAULT_WINDOW_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_HOURS;
  return n;
}

function readMinSamples(env: Record<string, string | undefined>): number {
  const raw = env.PULSE_ERROR_MIN_SAMPLES;
  if (!raw) return DEFAULT_MIN_SAMPLES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MIN_SAMPLES;
  return Math.floor(n);
}

function readRate(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

// Failure-ONLY audit events: these are audited exclusively on failure
// (there is no `*_succeeded` counterpart), so the failures/(failures+
// successes) rate is ALWAYS 100% whenever even one appears in the
// window. Rate-alarming them is structurally meaningless noise — a
// single transient/historical write failure pins the detector at 100%.
// They remain durable in the audit log for direct inspection (and
// /api/admin/audit-summary), which is the right surface for a
// failure-only signal. (2026-06-05: the Est_Rehab_Low patch_failed
// 8/8=100% false-alarm — the writes were already fixed in 04a0a44 /
// 90ce407; the detector was just echoing pre-fix entries at a
// structurally-fixed 100%.)
const DEFAULT_FAILURE_ONLY_EXCLUSIONS = [
  "patch_failed",
  "batch_patch_failed",
  "formula_field_write_blocked",
  "proposal_patch_failed",
  // Quarantine-working-as-designed: the event records the CARRIER's failure
  // (undeliverable number) — the quarantine action itself succeeded. It is
  // audited confirmed_failure with no success counterpart, so any quarantine
  // in the window pins the rate at 100% and fired a false critical + Tier-3
  // SMS on 2026-07-12 (5/5 during ~55-msg/48h live traffic). Belt health for
  // sends is the send-slot summary, not this event.
  "h2_outreach_delivery_quarantine",
];

function readExclusions(env: Record<string, string | undefined>): Set<string> {
  const out = new Set<string>(DEFAULT_FAILURE_ONLY_EXCLUSIONS);
  const raw = env.PULSE_ERROR_RATE_EXCLUDE;
  if (raw) {
    for (const s of raw.split(",").map((x) => x.trim()).filter((x) => x.length > 0)) {
      out.add(s);
    }
  }
  return out;
}

interface EventTally {
  success: number;
  failure: number;
  uncertain: number;
}

/** Pure: tally audit events by event name within the rolling window. */
export function tallyEventsByName(
  audit: AuditEntry[],
  windowHours: number,
  now: Date,
  exclusions: Set<string> = new Set(),
): Record<string, EventTally> {
  const cutoff = now.getTime() - windowHours * 3_600_000;
  const tallies: Record<string, EventTally> = {};
  for (const e of audit) {
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (exclusions.has(e.event)) continue;
    const tally = tallies[e.event] ?? (tallies[e.event] = { success: 0, failure: 0, uncertain: 0 });
    if (e.status === "confirmed_success") tally.success++;
    else if (e.status === "confirmed_failure") tally.failure++;
    else tally.uncertain++;
  }
  return tallies;
}

export function detectEndpointErrorRate(input: PulseDetectorInput): PulseDetection[] {
  const windowHours = readWindow(input.env);
  const minSamples = readMinSamples(input.env);
  const warningRate = readRate(input.env, "PULSE_ERROR_RATE_WARNING", DEFAULT_WARNING_RATE);
  const criticalRate = readRate(input.env, "PULSE_ERROR_RATE_CRITICAL", DEFAULT_CRITICAL_RATE);
  const exclusions = readExclusions(input.env);

  const tallies = tallyEventsByName(input.audit_log, windowHours, input.now(), exclusions);

  const fires: PulseDetection[] = [];
  for (const [event, tally] of Object.entries(tallies)) {
    const total = tally.success + tally.failure;
    if (total < minSamples) continue; // not enough data
    const rate = tally.failure / total;
    if (rate < warningRate) continue;

    const severity = rate >= criticalRate ? "critical" : "warning";
    fires.push({
      // Per-event ID so a flapping endpoint doesn't overwrite another.
      id: `endpoint_error_rate_high:${event}`,
      detector_id: "endpoint_error_rate_high",
      severity,
      title: `${event} failure rate ${Math.round(rate * 100)}% (${tally.failure}/${total} over ${windowHours}h)`,
      description: `Event "${event}" failed ${tally.failure} of ${total} calls in the last ${windowHours}h. Thresholds: warning ≥${Math.round(warningRate * 100)}% / critical ≥${Math.round(criticalRate * 100)}%.`,
      suggested_action: `Open /api/admin/audit-summary?event=${encodeURIComponent(event)} to see specific failure errors. Common patterns: external API key rotated, Airtable schema drift, downstream rate-limit.`,
      detected_at: input.now().toISOString(),
      source_data: {
        event,
        failures: tally.failure,
        successes: tally.success,
        uncertain: tally.uncertain,
        total,
        rate: Math.round(rate * 1000) / 1000,
        window_hours: windowHours,
        min_samples: minSamples,
        warning_rate: warningRate,
        critical_rate: criticalRate,
      },
    });
  }

  // Sort by severity desc, then rate desc — surfaces the worst first
  // when multiple endpoints fire simultaneously.
  fires.sort((a, b) => {
    const sa = a.severity === "critical" ? 3 : a.severity === "warning" ? 2 : 1;
    const sb = b.severity === "critical" ? 3 : b.severity === "warning" ? 2 : 1;
    if (sa !== sb) return sb - sa;
    const ra = (a.source_data?.rate as number) ?? 0;
    const rb = (b.source_data?.rate as number) ?? 0;
    return rb - ra;
  });

  return fires;
}
