// POST /api/admin/drift-test
//
// Deliberate-drift validator for the airtable read-back-after-write
// migration. Sandboxed to writes on the dashboard's test record so
// real production data can't be polluted. Used to verify three
// distinct drift cases fire as expected:
//
//   1. Positive control     — known-good value, no drift
//   2. Phantom-option       — write a non-existent singleSelect choice
//   3. Echo-mismatch        — write a value that Airtable normalizes
//
// Body:
//   { recordId, fields }
//
// Response:
//   { written, drift_count, drift, audit_event_will_fire }
//
// Hardcoded allowlist: only writes to the throwaway test record
// rece38peGR67eqIyG. Returns 403 for any other recordId so this
// endpoint can't be used as a write proxy for real records.

import { NextResponse } from "next/server";
import { updateListingRecord } from "@/lib/airtable";

export const runtime = "nodejs";
export const maxDuration = 30;

const ALLOWED_TEST_RECORD_IDS = new Set(["rece38peGR67eqIyG"]);

export async function POST(req: Request) {
  let body: { recordId?: string; fields?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { recordId, fields } = body;
  if (!recordId || !fields || typeof fields !== "object") {
    return NextResponse.json(
      { error: "Missing recordId or fields" },
      { status: 400 },
    );
  }

  if (!ALLOWED_TEST_RECORD_IDS.has(recordId)) {
    return NextResponse.json(
      {
        error: "Not a sandboxed test record. drift-test only operates on the dashboard's pre-allowlisted test record.",
        allowed: Array.from(ALLOWED_TEST_RECORD_IDS),
      },
      { status: 403 },
    );
  }

  try {
    const drift = await updateListingRecord(recordId, fields);
    return NextResponse.json({
      recordId,
      written: fields,
      drift_count: drift.length,
      drift,
      audit_event_will_fire: drift.length > 0,
      note: "Hit GET /api/admin/audit-summary to see the persisted entry (status: uncertain, agent: airtable-write).",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Airtable write failed", detail: String(err) },
      { status: 502 },
    );
  }
}
