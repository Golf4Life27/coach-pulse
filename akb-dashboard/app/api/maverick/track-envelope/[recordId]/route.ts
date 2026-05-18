// Maverick Track-in-Scribe endpoint (Phase 5.4).
// @agent: scribe
//
// User-triggered: deal-detail page surfaces a small input that lets
// Alex paste a DocuSign envelope GUID and link it to the listing.
// Writes Envelope_ID via the existing updateListingRecord PATCH path.
// Dashboard-session auth only — no MCP, no cron, no polling.
//
// Body: { envelope_id: string | null }
//   - non-empty string: writes the GUID
//   - null or empty string: clears the field (untrack)

import { NextResponse } from "next/server";
import { updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { hasDashboardSession } from "@/lib/maverick/oauth/auth-waterfall";

export const runtime = "nodejs";
export const maxDuration = 15;

// DocuSign envelope IDs are GUIDs (RFC 4122 v4). Accept the canonical
// hyphenated form. Strict regex prevents accidental writes of random
// strings (paste-from-wrong-clipboard guard).
const ENVELOPE_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const t0 = Date.now();
  const { recordId } = await params;

  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "invalid_record_id" }, { status: 400 });
  }

  // Dashboard-session only — this is a write to production Airtable
  // and should require active user attribution. Same model as the
  // existing /api/actions/* writes.
  if (!hasDashboardSession(req.headers.get("cookie"))) {
    return NextResponse.json(
      { error: "unauthorized", reason: "dashboard_session_required" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }
  const raw = (body as { envelope_id?: unknown } | null)?.envelope_id;
  let envelopeId: string | null;
  if (raw === null || raw === undefined || raw === "") {
    envelopeId = null;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!ENVELOPE_ID_RE.test(trimmed)) {
      return NextResponse.json(
        {
          error: "invalid_envelope_id_format",
          reason: "Expected a DocuSign envelope GUID (8-4-4-4-12 hex).",
        },
        { status: 400 },
      );
    }
    envelopeId = trimmed.toLowerCase();
  } else {
    return NextResponse.json({ error: "envelope_id_must_be_string_or_null" }, { status: 400 });
  }

  try {
    await updateListingRecord(recordId, { Envelope_ID: envelopeId ?? "" });
    await audit({
      agent: "scribe",
      event: envelopeId ? "envelope_tracked" : "envelope_untracked",
      status: "confirmed_success",
      inputSummary: { record_id: recordId, has_envelope: Boolean(envelopeId) },
      outputSummary: { envelope_id: envelopeId },
      ms: Date.now() - t0,
    });
    return NextResponse.json({ ok: true, envelope_id: envelopeId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "scribe",
      event: "envelope_track_failed",
      status: "confirmed_failure",
      inputSummary: { record_id: recordId },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { error: "track_envelope_failed", message: msg },
      { status: 500 },
    );
  }
}
