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

/** Forward-only activity cutoff (operator 2026-06-10): the 25 legacy
 *  pre-batch records with reply-asserting statuses and no recorded inbound
 *  are KNOWN, dispositioned forward-only, and must never nag again. Only
 *  records with outbound activity ON/after the first live batch (6/9) are
 *  in scope — every post-6/9 send stamps Last_Outbound_At, so a record
 *  with no outbound (or a pre-cutoff one) is legacy by definition. */
const DEFAULT_ACTIVITY_CUTOFF_ISO = "2026-06-09T00:00:00Z";

/** Pure: stable signature of the offending set, so the detection id changes
 *  ONLY when the CONDITION changes (different record set), not per tick.
 *  The runner's active-set diff then fires Spine/SMS once on the new id and
 *  holds it steady on subsequent scans — "once per condition, not per tick". */
export function conditionSignature(ids: string[]): string {
  const joined = [...ids].sort().join(",");
  let h = 5381;
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) + h + joined.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
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

export function detectUnbackedReplyStatus(
  input: PulseDetectorInput,
): PulseDetection[] {
  const cutoffRaw = input.env["PULSE_UNBACKED_STATUS_SINCE"] ?? DEFAULT_ACTIVITY_CUTOFF_ISO;
  const cutoff = Date.parse(cutoffRaw);
  const offending = input.listings.filter((l) => {
    if (!REPLY_IMPLYING_STATUSES.has(l.outreachStatus ?? "")) return false;
    if (l.lastInboundAt) return false;
    // Post-cutoff activity only — legacy records (no outbound, or outbound
    // before the first live batch) are forward-only dispositioned and out
    // of scope forever.
    if (!l.lastOutboundAt) return false;
    const t = Date.parse(l.lastOutboundAt);
    return Number.isFinite(t) && t >= cutoff;
  });
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
      // Condition-signature id: stable while the offending SET is unchanged
      // (runner holds it steady — no re-fire per tick), new id only when the
      // condition itself changes. "Once per condition, not per tick."
      id: `unbacked_reply_status_drift:${conditionSignature(offending.map((l) => l.id))}`,
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
