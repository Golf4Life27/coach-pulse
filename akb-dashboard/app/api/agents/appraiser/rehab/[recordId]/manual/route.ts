// INV-005 — Manual rehab affordance.
// @agent: appraiser
//
// POST /api/agents/appraiser/rehab/[recordId]/manual
//   body: { rehab_mid, rehab_low?, rehab_high?, source: "manual_operator" | "manual_partner" }
//
// Fallback path unlocked AFTER the GET sibling returns one of:
//   - no_photos_available (422)
//   - photo_collection_failed (502)
//   - vision_call_failed (502)
//
// Constitution Rule 3: manual is fallback-only. The UI is the gate —
// the manual form is only rendered after one of the failure surfaces
// is hit. There is no preemptive-skip path. The route accepts manual
// input unconditionally on the assumption that getting here implies
// the operator went through the UI (which implies automation failed
// first). API-level enforcement (e.g. requiring a Rehab_Last_Auto_
// Attempt_At field) would add 2 extra schema fields and was scoped
// out for v1 per operator decision.
//
// Writes Rehab_Source flag so all downstream consumers can render the
// provenance badge (BroCard PricingBlock, AppraiserRehabPanel).
// Nightly /api/cron/rehab-vision-retry re-runs vision for records
// flagged manual_operator and surfaces drift via Notes marker — never
// silently overwrites.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { writeState } from "@/lib/maverick/write-state";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  validateManualRehabPayload,
  buildManualRehabAirtableFields,
  buildManualRehabNoteLine,
} from "@/lib/appraiser/manual-rehab";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const t0 = Date.now();
  const { recordId } = await params;

  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "invalid_record_id" }, { status: 400 });
  }

  // ── Auth waterfall (mirrors GET sibling) ────────────────────────
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
  // Cron must not write manual rehab — it's an operator action.
  if (authKind === "cron") {
    return NextResponse.json(
      { error: "cron_disallowed", reason: "manual rehab is operator-only (Type 2A/2C)" },
      { status: 403 },
    );
  }

  // ── Parse + validate body ───────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", reason: "request body must be valid JSON" },
      { status: 400 },
    );
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { error: "invalid_body", reason: "request body must be a JSON object" },
      { status: 400 },
    );
  }
  const validated = validateManualRehabPayload(body as Parameters<typeof validateManualRehabPayload>[0]);
  if (!validated.ok) {
    return NextResponse.json(validated.error, { status: 400 });
  }

  // ── Confirm listing exists ──────────────────────────────────────
  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json(
      { error: "listing_not_found", recordId },
      { status: 404 },
    );
  }

  // ── Build payload + write ───────────────────────────────────────
  const now = new Date();
  const nowIso = now.toISOString();
  const fieldsToWrite = buildManualRehabAirtableFields(validated.value, nowIso);
  const noteLine = buildManualRehabNoteLine(now, validated.value);
  const nextNotes = listing.notes ? `${listing.notes}\n${noteLine}` : noteLine;

  let airtableError: string | null = null;
  try {
    await updateListingRecord(recordId, {
      ...fieldsToWrite,
      Verification_Notes: nextNotes,
    });
  } catch (err) {
    airtableError = err instanceof Error ? err.message : String(err);
  }

  // ── Audit log (per Positive Confirmation Principle) ─────────────
  await audit({
    agent: "appraiser",
    event: "rehab_manual_set",
    status: airtableError ? "confirmed_failure" : "confirmed_success",
    inputSummary: {
      record_id: recordId,
      auth_kind: authKind,
      source: validated.value.source,
      rehab_mid: validated.value.rehabMid,
    },
    outputSummary: {
      rehab_low: validated.value.rehabLow,
      rehab_high: validated.value.rehabHigh,
      airtable_error: airtableError,
      duration_ms: Date.now() - t0,
    },
    decision: validated.value.source,
    recordId,
    error: airtableError ?? undefined,
  });

  if (airtableError) {
    return NextResponse.json(
      { error: "airtable_write_failed", message: airtableError },
      { status: 502 },
    );
  }

  // ── Spine entry (durable, one per manual write) ─────────────────
  try {
    await writeState({
      event_type: "build_event",
      attribution_agent: "appraiser",
      title: `Manual rehab set: ${listing.address ?? recordId} → $${validated.value.rehabMid.toLocaleString("en-US")} (${validated.value.source})`,
      description:
        `INV-005 manual rehab affordance. Operator entered Est_Rehab = ` +
        `$${validated.value.rehabMid.toLocaleString("en-US")} ` +
        `(low $${validated.value.rehabLow.toLocaleString("en-US")} / high $${validated.value.rehabHigh.toLocaleString("en-US")}) ` +
        `for ${listing.address ?? "record"} (${recordId}). ` +
        `Rehab_Source=${validated.value.source}. ` +
        `Nightly cron will re-attempt vision and surface drift if any.`,
      related_listing: recordId,
    });
  } catch (err) {
    // Spine failure does not abort the write — Airtable + audit already
    // landed. Log and continue (mirrors INV-006 cron pattern).
    console.error(`[rehab-manual] Spine write failed for ${recordId}:`, err);
  }

  return NextResponse.json({
    ok: true,
    record_id: recordId,
    rehab: {
      mid: validated.value.rehabMid,
      low: validated.value.rehabLow,
      high: validated.value.rehabHigh,
    },
    source: validated.value.source,
    estimated_at: nowIso,
    duration_ms: Date.now() - t0,
  });
}
