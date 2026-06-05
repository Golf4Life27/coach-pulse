// Operator disposition — terminal kill through the stage engine.
// @agent: operator
//
// GET  /api/admin/dispose-listing?recordId=rec...&confirm=dead&reason=...
// POST /api/admin/dispose-listing   { recordId, reason }
//
// Moves a listing to the terminal `dead` Pipeline_Stage via the stage
// engine's kill edge (transitions: any non-terminal → dead). The engine
// stays the SOLE writer of Pipeline_Stage — this route NEVER writes the
// field directly; it calls transitionStage with triggered_by:"operator".
//
// Use case (2026-06-05): a contract terminated / deal lost. The record
// must drop out of the live operator view, which the Track B dead-filter
// (pipelineStage==="dead" excluded by default) does automatically once
// the stage is dead. We ALSO set Outreach_Status="Dead" — a separate,
// non-stage field — so the Outreach_Status-keyed views agree. That write
// does not violate the engine-sole-writer rule (it isn't Pipeline_Stage).
//
// Safety: the mutating path requires confirm=dead (GET) or a JSON body
// (POST) so a bare GET can't accidentally kill a record. Idempotent —
// re-firing on an already-dead record is an engine noop.
//
// Auth posture: same as the rest of /api/admin/* — no app-level auth,
// Vercel deployment-layer access control. The confirm gate is the
// accidental-fire guard.

import { NextResponse } from "next/server";
import { transitionStage } from "@/lib/pipeline-state/engine";
import { updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 60;

async function dispose(recordId: string, reason: string) {
  // 1. Pipeline_Stage → dead THROUGH THE ENGINE (sole writer; kill edge).
  const result = await transitionStage({
    recordId,
    to: "dead",
    reason,
    attribution: "operator",
    triggered_by: "operator",
  });

  // 2. Outreach_Status="Dead" — terminal disposition for the
  //    Outreach_Status-keyed views. Only when the stage transition
  //    actually applied (or was already dead) — don't half-dispose a
  //    record the engine refused. Best-effort; surfaced in the response.
  let outreachWrite: { ok: boolean; error: string | null } = { ok: false, error: "skipped" };
  if (result.ok) {
    try {
      await updateListingRecord(recordId, {
        fldGIgqwyCJg4uFyv: "Dead", // Outreach_Status
        fldOrWvqKcc1g6Lka: "Reject", // Execution_Path
      });
      outreachWrite = { ok: true, error: null };
    } catch (err) {
      outreachWrite = { ok: false, error: String(err).slice(0, 300) };
    }
  }

  await audit({
    agent: "operator",
    event: "listing_disposed",
    status: result.ok ? "confirmed_success" : "confirmed_failure",
    recordId,
    inputSummary: { reason },
    outputSummary: {
      stage_outcome: result.outcome,
      from: result.from,
      to: result.to,
      legality_reason: result.legality.reason,
      outreach_write_ok: outreachWrite.ok,
    },
    decision: result.outcome,
  });

  return { result, outreachWrite };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const recordId = url.searchParams.get("recordId");
  const confirm = url.searchParams.get("confirm");
  const reason = url.searchParams.get("reason") ?? "operator disposition (no reason given)";

  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "missing_or_invalid_recordId" }, { status: 400 });
  }
  if (confirm !== "dead") {
    return NextResponse.json(
      { error: "confirm_required", detail: "pass &confirm=dead to execute the kill-to-dead transition" },
      { status: 400 },
    );
  }

  const { result, outreachWrite } = await dispose(recordId, reason);
  return NextResponse.json({
    ok: result.ok,
    recordId,
    stage_transition: {
      outcome: result.outcome,
      from: result.from,
      to: result.to,
      legality_reason: result.legality.reason,
      message: result.message,
      applied_at: result.applied_at,
    },
    outreach_status_write: outreachWrite,
  }, { status: result.ok ? 200 : 409 });
}

export async function POST(req: Request) {
  let body: { recordId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const recordId = body.recordId;
  const reason = body.reason ?? "operator disposition (no reason given)";
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "missing_or_invalid_recordId" }, { status: 400 });
  }

  const { result, outreachWrite } = await dispose(recordId, reason);
  return NextResponse.json({
    ok: result.ok,
    recordId,
    stage_transition: {
      outcome: result.outcome,
      from: result.from,
      to: result.to,
      legality_reason: result.legality.reason,
      message: result.message,
      applied_at: result.applied_at,
    },
    outreach_status_write: outreachWrite,
  }, { status: result.ok ? 200 : 409 });
}
