// Catches the next 5/1-style status corruption while it's still small.
//
// Forensic background (2026-06-08): 30 records system-wide carried
// Outreach_Status="Response Received" with no recorded inbound timestamp.
// 16 of them were a single bulk-write on 5/1 19:20-22 UTC; the rest
// scattered across organic creates. ALL in-code writers
// (scan-replies, resurrection) ALWAYS stamp Last_Inbound_At — so the
// bulk had to come from off-platform (Make L3 Reply_Triage_V3, or a
// CSV/manual edit). This detector watches for the SHAPE so the next
// occurrence surfaces within a day instead of being discovered weeks
// later by a forensic dig.
//
// Fires when more than N active records carry a reply-implying status
// without Last_Inbound_At. Threshold defaults are conservative (a few
// records are normal noise from off-platform writers); the spike that
// produced 16-in-2-minutes is way above the floor.

import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const REPLY_IMPLYING_STATUSES = new Set([
  "Response Received",
  "Counter Received",
  "Negotiating",
  "Offer Accepted",
]);

const DEFAULT_WARNING_FLOOR = 5;
const DEFAULT_CRITICAL_FLOOR = 12;

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

export function detectUnbackedReplyStatus(
  input: PulseDetectorInput,
): PulseDetection[] {
  const offending = input.listings.filter(
    (l) =>
      REPLY_IMPLYING_STATUSES.has(l.outreachStatus ?? "") &&
      !l.lastInboundAt,
  );
  if (offending.length === 0) return [];

  const warningFloor = readIntThreshold(
    input.env,
    "PULSE_UNBACKED_STATUS_WARNING",
    DEFAULT_WARNING_FLOOR,
  );
  const criticalFloor = readIntThreshold(
    input.env,
    "PULSE_UNBACKED_STATUS_CRITICAL",
    DEFAULT_CRITICAL_FLOOR,
  );

  if (offending.length < warningFloor) return [];

  const severity: PulseDetection["severity"] =
    offending.length >= criticalFloor ? "critical" : "warning";

  // Bucket by state so a Detroit-vs-TX-vs-TN burst tells us where to look.
  const byState: Record<string, number> = {};
  for (const l of offending) {
    const s = l.state ?? "??";
    byState[s] = (byState[s] ?? 0) + 1;
  }

  // Sample a few record IDs / addresses for the source_data block — capped
  // so the audit row stays bounded.
  const sample = offending.slice(0, 8).map((l) => ({
    id: l.id,
    address: l.address,
    state: l.state,
    status: l.outreachStatus,
    last_outbound_at: l.lastOutboundAt ?? null,
  }));

  return [
    {
      id: "unbacked_reply_status_drift",
      detector_id: "unbacked_reply_status",
      severity,
      title: `${offending.length} active records assert a reply but carry no recorded inbound`,
      description:
        `Records with Outreach_Status in {Response Received, Counter Received, Negotiating, Offer Accepted} should ALWAYS have Last_Inbound_At populated — the in-code writers (scan-replies, resurrection) always stamp it. ${offending.length} records lack it, meaning an off-platform writer (Make L3 Reply_Triage_V3 / CSV import / manual table edit) wrote the status without the timestamp. The 2026-05-01 19:20-22 UTC MI bulk had this exact shape. Bucketed by state: ${Object.entries(byState).map(([s, n]) => `${s}=${n}`).join(", ")}.`,
      suggested_action:
        "Run /api/admin/outreach-status-audit to see the full reviewable list (impossible vs unverified). Trace the recent writer via /api/admin/audit-tail?event=... if a Make scenario was the source; otherwise check the Airtable record-revision history for the affected rows.",
      detected_at: input.now().toISOString(),
      source_data: {
        offending_count: offending.length,
        warning_floor: warningFloor,
        critical_floor: criticalFloor,
        by_state: byState,
        sample,
      },
    },
  ];
}
