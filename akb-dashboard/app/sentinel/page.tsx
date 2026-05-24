// Phase 13 / N.3 — Sentinel approval-queue page.
//
// Full-page surface for the inbound approval queue. Compact teaser
// lives in the factory-floor SentinelRoom; full UX (per-row classify
// + draft + approve / edit / dismiss) lives here where there's room.

import SentinelApprovalQueue from "@/components/sentinel/SentinelApprovalQueue";

export default function SentinelPage() {
  return <SentinelApprovalQueue />;
}
