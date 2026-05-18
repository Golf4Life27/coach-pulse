// Phase 14 / O.1 — stale-data-drift detector.
//
// Carries forward the 33-response-cluster class of failure: active
// deals where the agent owes us a reply but the thread has aged
// without any movement on either side. Pulse counts listings in
// active outreach status where MAX(lastInboundAt, lastOutboundAt)
// is older than N days. Above warning threshold → fire warning;
// above critical threshold → fire critical.

import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";
import type { Listing } from "@/lib/types";

const DEFAULT_STALE_DAYS = 14;
const DEFAULT_WARNING_COUNT = 5;
const DEFAULT_CRITICAL_COUNT = 20;

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

/** Pure: most-recent touch timestamp across both directions, ms. Null
 *  when neither side has touched the listing. */
export function mostRecentTouchMs(listing: Pick<Listing, "lastInboundAt" | "lastOutboundAt">): number | null {
  const inb = listing.lastInboundAt ? new Date(listing.lastInboundAt).getTime() : NaN;
  const out = listing.lastOutboundAt ? new Date(listing.lastOutboundAt).getTime() : NaN;
  const candidates: number[] = [];
  if (Number.isFinite(inb)) candidates.push(inb);
  if (Number.isFinite(out)) candidates.push(out);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/** Pure: filter listings to those whose most-recent touch is older
 *  than `staleDays` days from `now`. */
export function findStaleListings(
  listings: Listing[],
  staleDays: number,
  now: Date,
): Array<{ id: string; address: string; days_since_touch: number }> {
  const cutoff = now.getTime() - staleDays * 86_400_000;
  const out: Array<{ id: string; address: string; days_since_touch: number }> = [];
  for (const l of listings) {
    const latest = mostRecentTouchMs(l);
    if (latest == null) continue;
    if (latest >= cutoff) continue;
    const days = Math.floor((now.getTime() - latest) / 86_400_000);
    out.push({ id: l.id, address: l.address, days_since_touch: days });
  }
  out.sort((a, b) => b.days_since_touch - a.days_since_touch);
  return out;
}

export function detectStaleDataDrift(input: PulseDetectorInput): PulseDetection[] {
  const staleDays = readIntThreshold(input.env, "PULSE_STALE_DRIFT_DAYS", DEFAULT_STALE_DAYS);
  const warningCount = readIntThreshold(input.env, "PULSE_STALE_DRIFT_WARNING_COUNT", DEFAULT_WARNING_COUNT);
  const criticalCount = readIntThreshold(input.env, "PULSE_STALE_DRIFT_CRITICAL_COUNT", DEFAULT_CRITICAL_COUNT);

  const stale = findStaleListings(input.listings, staleDays, input.now());
  if (stale.length < warningCount) return [];

  const severity = stale.length >= criticalCount ? "critical" : "warning";
  const sample = stale.slice(0, 5);
  return [
    {
      id: "stale_data_drift",
      detector_id: "stale_data_drift",
      severity,
      title: `${stale.length} active deals stale >${staleDays}d (≥${severity === "critical" ? criticalCount : warningCount} → ${severity})`,
      description: `Active-pipeline listings with no inbound or outbound movement in >${staleDays} days: ${stale.length}. Oldest: ${sample.map((s) => `${s.address} (${s.days_since_touch}d)`).join(", ") || "(none)"}.`,
      suggested_action:
        severity === "critical"
          ? "Triage cluster — bulk-mark dead or fire re-engagement sweep via /api/admin/d3-cadence. The 33-response-cluster pattern from 5/18's session-open briefing is what this detector catches."
          : "Review the stale list on /pipeline. Either re-engage or mark dead to clear the active-status drift.",
      detected_at: input.now().toISOString(),
      source_data: {
        stale_count: stale.length,
        stale_days_threshold: staleDays,
        warning_threshold: warningCount,
        critical_threshold: criticalCount,
        oldest_sample: sample,
      },
    },
  ];
}
