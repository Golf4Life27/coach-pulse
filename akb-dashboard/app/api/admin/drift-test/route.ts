// GET /api/admin/drift-test?recordId=...&fieldId=...&value=...&valueType=string|number
//
// Deliberate-drift validator for the airtable read-back-after-write
// migration. Sandboxed to writes on the dashboard's test record so
// real production data can't be polluted. Used to verify drift
// detection layers fire as expected:
//
//   Layer A: echo-comparison (number/datetime/string normalization)
//   Layer B: schema-aware singleSelect/multipleSelects phantom-option
//
// Hardcoded allowlist: only writes to allowlisted test record(s).
// Returns 403 for any other recordId so this endpoint can't be used
// as a write proxy for real records.
//
// Why GET: this endpoint is invoked from outside the sandbox via the
// Vercel MCP web_fetch_vercel_url tool, which is GET-only. Side-effect-
// on-GET is intentional and explicitly scoped to test records.

import { NextResponse } from "next/server";
import { updateListingRecord } from "@/lib/airtable";

export const runtime = "nodejs";
export const maxDuration = 30;

const ALLOWED_TEST_RECORD_IDS = new Set(["rece38peGR67eqIyG"]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const recordId = url.searchParams.get("recordId");
  const fieldId = url.searchParams.get("fieldId");
  const rawValue = url.searchParams.get("value");
  const valueType = url.searchParams.get("valueType") ?? "string";

  if (!recordId || !fieldId || rawValue == null) {
    return NextResponse.json(
      { error: "Missing recordId, fieldId, or value" },
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

  let value: unknown = rawValue;
  if (valueType === "number") {
    const n = Number(rawValue);
    if (isNaN(n)) {
      return NextResponse.json(
        { error: `Invalid number value: ${rawValue}` },
        { status: 400 },
      );
    }
    value = n;
  } else if (valueType === "null") {
    value = null;
  }

  try {
    const drift = await updateListingRecord(recordId, { [fieldId]: value });
    return NextResponse.json({
      recordId,
      written: { [fieldId]: value },
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
