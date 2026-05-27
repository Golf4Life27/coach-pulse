// ZIP approval-gate feed (Workstream D1, item 4).
//
// GET /api/zip-registry/queue
//
// Metadata-only listing of ZIPs in Market_Tier=approval_pending. Powers
// the <ZIPApprovalQueue /> dashboard panel. No mutations here — Approve/
// Reject route through POST /api/zip-registry/decision.

import { NextResponse } from "next/server";
import { getApprovalPendingRows } from "@/lib/zip-registry";

export const runtime = "nodejs";
export const maxDuration = 30;

export interface ZipQueueItem {
  recordId: string;
  zip: string;
  state: string | null;
  market: string | null;
  approval_requested_at: string | null;
  memphis_required: boolean;
  notes: string | null;
}

export async function GET() {
  try {
    const rows = await getApprovalPendingRows();
    const items: ZipQueueItem[] = rows
      .map((r) => ({
        recordId: r.recordId,
        zip: r.zip,
        state: r.state,
        market: r.market,
        approval_requested_at: r.approvalRequestedAt,
        memphis_required: r.memphisRequired,
        notes: r.notes,
      }))
      .sort((a, b) => {
        // Oldest request first — operator clears the longest-waiting ZIPs.
        const ta = a.approval_requested_at ? Date.parse(a.approval_requested_at) : Infinity;
        const tb = b.approval_requested_at ? Date.parse(b.approval_requested_at) : Infinity;
        return ta - tb;
      });
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
