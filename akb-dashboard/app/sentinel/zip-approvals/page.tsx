// Phase 14 / D1 — ZIP market-expansion approval gate page.
//
// Full-page surface for ZIPs awaiting a go/no-go before active outreach.
// Reads Market_Tier=approval_pending from ZIP_Registry.

import ZIPApprovalQueue from "@/components/sentinel/ZIPApprovalQueue";

export default function ZipApprovalsPage() {
  return <ZIPApprovalQueue />;
}
