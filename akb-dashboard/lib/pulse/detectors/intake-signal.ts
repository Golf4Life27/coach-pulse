// Phase 13.1 + 13.2 / Q.3 — Sentinel intake-signal detector.
//
// Two-mode detector:
//   13.1: surfaces when there's a non-trivial Multi-Listing Queued
//         backlog — "N listings waiting for intake processing".
//   13.2: surfaces when active inventory (Texted/Negotiating/etc)
//         drops below a configured floor — "pipeline is starved,
//         consider intake sweep".
//
// Both signals tie back to Sentinel's intake responsibility. They
// don't trigger autonomous intake — operator decides. Pulse just
// surfaces.

import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_QUEUED_WARNING = 5;
const DEFAULT_QUEUED_CRITICAL = 20;
const DEFAULT_LOW_INVENTORY_WARNING = 15;
const DEFAULT_LOW_INVENTORY_CRITICAL = 5;

function readInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

const ACTIVE_STATUSES = new Set([
  "Texted",
  "Emailed",
  "Response Received",
  "Counter Received",
  "Negotiating",
  "Offer Accepted",
]);

/** Pure: count listings whose outreachStatus is in the active set. */
export function countActiveInventory(
  listings: PulseDetectorInput["listings"],
): number {
  let n = 0;
  for (const l of listings) {
    if (l.outreachStatus && ACTIVE_STATUSES.has(l.outreachStatus)) n++;
  }
  return n;
}

/** Pure: count listings flagged Multi-Listing Queued (intake backlog). */
export function countMultiListingQueued(
  listings: PulseDetectorInput["listings"],
): number {
  let n = 0;
  for (const l of listings) {
    if (l.outreachStatus === "Multi-Listing Queued") n++;
  }
  return n;
}

export function detectIntakeSignal(input: PulseDetectorInput): PulseDetection[] {
  const queuedWarn = readInt(input.env, "PULSE_INTAKE_QUEUED_WARNING", DEFAULT_QUEUED_WARNING);
  const queuedCrit = readInt(input.env, "PULSE_INTAKE_QUEUED_CRITICAL", DEFAULT_QUEUED_CRITICAL);
  const inventoryWarn = readInt(input.env, "PULSE_INTAKE_INVENTORY_WARNING", DEFAULT_LOW_INVENTORY_WARNING);
  const inventoryCrit = readInt(input.env, "PULSE_INTAKE_INVENTORY_CRITICAL", DEFAULT_LOW_INVENTORY_CRITICAL);

  const queued = countMultiListingQueued(input.listings);
  const active = countActiveInventory(input.listings);
  const fires: PulseDetection[] = [];

  // 13.1 — Multi-Listing Queued backlog.
  if (queued >= queuedWarn) {
    const severity = queued >= queuedCrit ? "critical" : "warning";
    fires.push({
      id: "intake_queued_backlog",
      detector_id: "stale_data_drift", // reusing closest existing id; future migration extends PulseDetectorId
      severity,
      title: `${queued} listing${queued === 1 ? "" : "s"} in Multi-Listing Queued (intake backlog)`,
      description: `Sentinel has ${queued} listings waiting for intake processing (Multi-Listing Queued status). These won't reach the active pipeline until processed. Operator-configured thresholds: warning ≥${queuedWarn}, critical ≥${queuedCrit}.`,
      suggested_action:
        severity === "critical"
          ? "Run intake sweep via /api/process-intake or operator review. Queue this size suggests intake automation hasn't fired recently."
          : "Schedule an intake batch to process the queue. Or confirm the queue is intentional (waiting on listing verification).",
      detected_at: input.now().toISOString(),
      source_data: { queued, warning: queuedWarn, critical: queuedCrit },
    });
  }

  // 13.2 — Active inventory low. Skip when listings array is empty
  // — that's "no data" (KV cold start, briefing aggregator returned
  // nothing), not "intake is starved". Cron-cycle-silent detector
  // covers the no-data case separately.
  if (input.listings.length === 0) return fires;

  if (active <= inventoryWarn) {
    const severity = active <= inventoryCrit ? "critical" : "warning";
    fires.push({
      id: "intake_inventory_low",
      detector_id: "stale_data_drift", // closest existing id; same as above
      severity,
      title: `Active inventory low — ${active} listing${active === 1 ? "" : "s"} in active outreach status`,
      description: `Active-pipeline count: ${active} (Texted/Emailed/Response Received/Counter Received/Negotiating/Offer Accepted). Operator-configured floor: warning ≤${inventoryWarn}, critical ≤${inventoryCrit}. Sentinel intake hasn't replenished the funnel in a while.`,
      suggested_action:
        severity === "critical"
          ? "Run intake sweep — pipeline is starved. Confirm PropStream feed is live (Phase 13.3 Crawler 1.0 prerequisite)."
          : "Schedule the next intake batch. Track whether market activity is genuinely quieter or whether intake automation is the bottleneck.",
      detected_at: input.now().toISOString(),
      source_data: { active_count: active, warning: inventoryWarn, critical: inventoryCrit },
    });
  }

  return fires;
}
