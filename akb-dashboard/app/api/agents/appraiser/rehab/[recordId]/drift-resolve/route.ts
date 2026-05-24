// INV-005 — Rehab vision-vs-manual drift resolution.
// @agent: appraiser
//
// POST /api/agents/appraiser/rehab/[recordId]/drift-resolve
//   body: { resolution: "accept_vision" | "keep_manual" }
//
// Called from AppraiserRehabPanel's drift banner. The nightly retry
// cron writes a DRIFT_NOTES_MARKER line when vision diverges from the
// manual entry by more than 25%. This route lets the operator resolve
// the divergence with two outcomes:
//
//   accept_vision → re-runs the vision GET path (returns to the
//                   autonomous pipeline; Rehab_Source flips to "vision").
//                   The DRIFT_RESOLVED_MARKER is appended to Notes so the
//                   banner suppresses; the vision write is the
//                   authoritative new state.
//
//   keep_manual   → no field changes. DRIFT_RESOLVED_MARKER appended to
//                   Notes so the banner suppresses. Rehab_Source stays
//                   manual_operator. Next cron tick (after cooldown)
//                   will re-test and may surface drift again if it
//                   persists; operator can keep dismissing.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { buildDriftResolvedLine } from "@/lib/maverick/rehab-vision-retry";

export const runtime = "nodejs";
export const maxDuration = 60;

const VALID_RESOLUTIONS = new Set(["accept_vision", "keep_manual"]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const t0 = Date.now();
  const { recordId } = await params;

  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "invalid_record_id" }, { status: 400 });
  }

  // Auth waterfall (mirrors POST /manual sibling).
  const cookieHeader = req.headers.get("cookie");
  const isDashboard = hasDashboardSession(cookieHeader);
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" =
    "none";
  if (isDashboard) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired =
      kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json(
          { error: "unauthorized", reason: auth.reason },
          { status: 401 },
        );
      }
      authKind = auth.kind;
    }
  }
  if (authKind === "cron") {
    return NextResponse.json(
      { error: "cron_disallowed", reason: "drift resolution is operator-only" },
      { status: 403 },
    );
  }

  let body: { resolution?: unknown };
  try {
    body = (await req.json()) as { resolution?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (
    typeof body.resolution !== "string" ||
    !VALID_RESOLUTIONS.has(body.resolution)
  ) {
    return NextResponse.json(
      {
        error: "invalid_resolution",
        reason: "resolution must be 'accept_vision' or 'keep_manual'",
      },
      { status: 400 },
    );
  }
  const resolution = body.resolution as "accept_vision" | "keep_manual";

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json(
      { error: "listing_not_found", recordId },
      { status: 404 },
    );
  }

  const now = new Date();
  const resolvedLine = buildDriftResolvedLine(
    now,
    resolution === "accept_vision" ? "accepted_vision" : "kept_manual",
  );
  const nextNotes = listing.notes
    ? `${listing.notes}\n${resolvedLine}`
    : resolvedLine;

  try {
    await updateListingRecord(recordId, { Verification_Notes: nextNotes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "airtable_write_failed", message: msg },
      { status: 502 },
    );
  }

  await audit({
    agent: "appraiser",
    event: "rehab_drift_resolved",
    status: "confirmed_success",
    inputSummary: {
      record_id: recordId,
      auth_kind: authKind,
      resolution,
    },
    outputSummary: { duration_ms: Date.now() - t0 },
    decision: resolution,
    recordId,
  });

  return NextResponse.json({
    ok: true,
    record_id: recordId,
    resolution,
    next_action:
      resolution === "accept_vision"
        ? "operator should hit GET rehab to re-run vision pipeline"
        : "manual value retained",
    duration_ms: Date.now() - t0,
  });
}
