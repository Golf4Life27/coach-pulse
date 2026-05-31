// ZIP approval-gate decision endpoint (Workstream D1, item 4).
//
// POST /api/zip-registry/decision
//   { recordId, decision: "approve" | "reject", operator?, notes? }
//
// Approve → Market_Tier=active. Reject → Market_Tier=paused (+ Notes).
// Both stamp Approved_By + Approval_Method="dashboard" and append a
// Spine_Decision_Log row (refs the approval-gate model recGtpPH4YxvUL2V8).

import { NextResponse } from "next/server";
import {
  getApprovalPendingRows,
  approveZip,
  rejectZip,
} from "@/lib/zip-registry";
import { writeState } from "@/lib/maverick/write-state";

export const runtime = "nodejs";
export const maxDuration = 30;

const APPROVAL_GATE_SPINE = "recGtpPH4YxvUL2V8";

interface DecisionBody {
  recordId?: string;
  decision?: "approve" | "reject";
  operator?: string;
  notes?: string;
}

export async function POST(req: Request) {
  let body: DecisionBody;
  try {
    body = (await req.json()) as DecisionBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { recordId, decision } = body;
  if (!recordId) return NextResponse.json({ error: "recordId required" }, { status: 400 });
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400 });
  }
  if (decision === "reject" && (!body.notes || !body.notes.trim())) {
    return NextResponse.json({ error: "notes required when rejecting" }, { status: 400 });
  }

  // Find the pending row so we have ZIP/Market for the Spine entry and the
  // existing Notes for reject-append. Guards against acting on a ZIP that
  // already left approval_pending (double-click / SMS race).
  const pending = await getApprovalPendingRows();
  const row = pending.find((r) => r.recordId === recordId);
  if (!row) {
    return NextResponse.json(
      { error: "not_pending", detail: "ZIP is not in approval_pending (already decided?)" },
      { status: 409 },
    );
  }

  const operator = (body.operator && body.operator.trim()) || "operator";
  const approvedBy = `${operator} @ ${new Date().toISOString()}`;

  try {
    if (decision === "approve") {
      await approveZip(recordId, { approvedBy, method: "dashboard" });
    } else {
      await rejectZip(recordId, {
        approvedBy,
        method: "dashboard",
        notes: body.notes,
        existingNotes: row.notes,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: "airtable_write_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const nextTier = decision === "approve" ? "active" : "paused";
  try {
    await writeState({
      event_type: "decision",
      attribution_agent: "scout",
      title: `ZIP ${row.zip} ${decision === "approve" ? "APPROVED" : "REJECTED"} (dashboard) → ${nextTier}`,
      description:
        `Operator ${decision === "approve" ? "approved" : "rejected"} market-expansion ZIP ${row.zip} ` +
        `(${[row.market, row.state].filter(Boolean).join(", ")}) via the dashboard approval gate. ` +
        `Market_Tier ${row.marketTier ?? "approval_pending"} → ${nextTier}. Decided by ${approvedBy}.` +
        (decision === "reject" && body.notes ? ` Reason: ${body.notes.trim()}` : ""),
      related_spine_decision: APPROVAL_GATE_SPINE,
    });
  } catch (err) {
    // Spine write is non-fatal — the Airtable flip already succeeded.
    console.error("[zip-registry/decision] Spine write failed:", err);
  }

  return NextResponse.json({ ok: true, recordId, zip: row.zip, market_tier: nextTier });
}
