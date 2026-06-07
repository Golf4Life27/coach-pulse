// Strathmoor #001 — operator-authorized one-shot soft re-engagement send.
// @agent: outreach
//
// CONTROLLED PATH ONLY. H2 stays hard-disabled. This route fires the
// EXACT operator-approved script to ONE listing agent (Charles Campbell,
// 15875 Strathmoor St). Idempotent: the route writes a sentinel to the
// record's Verification_Notes after a successful send; on any subsequent
// fire (cron or manual), the sentinel-check noops. Schedule is Sunday
// 14:00 UTC (= 10:00 AM ET).
//
// Send semantics (operator brief, 2026-06-06):
//   • To: Charles Campbell, 561-632-9673 (listing agent on the record)
//   • Opener: $45,000 cash, quick close
//   • Ceiling: $50,000 hard — informational annotation on the record
//   • Script (verbatim): see SCRIPT below
//   • Reply routes to Alex (downstream — handled by the existing reply
//     pipeline; not in scope here)
//
// Sentinel: STRATHMOOR_SOFT_REENGAGE_SENT — present in Verification_Notes
// after a successful send. Re-fire produces noop status:"already_sent".

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { sendMessageWithId } from "@/lib/quo";
import { normalizePhone } from "@/lib/phone-normalize";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

const RECORD_ID = "rec07YAC9KOwr6iZv";          // 15875 Strathmoor St (48227)
const AGENT_NAME = "Charles Campbell";
const AGENT_PHONE = "561-632-9673";
const SENTINEL = "STRATHMOOR_SOFT_REENGAGE_SENT";
const SCRIPT =
  "Hi Charles, this is Alex with AKB Solutions. I see 15875 Strathmoor St is still available. " +
  "I took a closer look at the condition — the roof, the unfinished bathroom, and the kitchen — " +
  "would the seller be interested in $45,000 cash with a quick close?";

async function handle(req: Request) {
  const t0 = Date.now();
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
  }
  if (auth.kind !== "cron" && auth.kind !== "oauth") {
    return NextResponse.json({ error: "unauthorized", reason: "unsupported_auth_kind" }, { status: 401 });
  }
  if (auth.kind === "oauth" && !kvConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 500 });
  }

  const listing = await getListing(RECORD_ID);
  if (!listing) {
    await audit({ agent: "outreach", event: "strathmoor_soft_reengage", status: "confirmed_failure", recordId: RECORD_ID, outputSummary: { stage: "record_missing" } });
    return NextResponse.json({ ok: false, error: "record_missing" }, { status: 404 });
  }

  // Idempotency — sentinel check.
  const existingNotes = listing.notes ?? "";
  if (existingNotes.includes(SENTINEL)) {
    await audit({ agent: "outreach", event: "strathmoor_soft_reengage", status: "confirmed_success", recordId: RECORD_ID, outputSummary: { status: "already_sent_noop" } });
    return NextResponse.json({ ok: true, status: "already_sent_noop", message: "Sentinel present; no-op." });
  }

  // Defensive: verify the listing-agent shape matches what the operator authorized.
  const phone = normalizePhone(AGENT_PHONE);
  if (!phone) {
    await audit({ agent: "outreach", event: "strathmoor_soft_reengage", status: "confirmed_failure", recordId: RECORD_ID, outputSummary: { stage: "phone_normalize_failed" } });
    return NextResponse.json({ ok: false, error: "phone_normalize_failed" }, { status: 500 });
  }

  // Fire the Quo send. Throws → caught below; sentinel NOT written on fail
  // so the next slot retries (idempotency holds: only a successful send
  // writes the sentinel).
  let sendResult;
  try {
    sendResult = await sendMessageWithId(phone, SCRIPT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "outreach",
      event: "strathmoor_soft_reengage",
      status: "confirmed_failure",
      recordId: RECORD_ID,
      inputSummary: { to: phone, agent_name: AGENT_NAME, script_preview: SCRIPT.slice(0, 80) },
      outputSummary: { stage: "quo_send_threw" },
      error: msg,
    });
    return NextResponse.json({ ok: false, error: "quo_send_failed", message: msg }, { status: 500 });
  }

  // Annotate the record: send marker + operator-override context + sentinel.
  const ts = new Date().toISOString();
  const annotation =
    `\n\n${ts.slice(0, 10)} — STRATHMOOR-SOFT-REENGAGE SENT (operator-override re-engagement). ` +
    `Quo msg ${sendResult.id ?? "(no id)"} → ${AGENT_NAME} ${AGENT_PHONE}. Opener $45,000 / ceiling $50,000 hard. ` +
    `Reply routes to Alex. ` +
    `Script: "${SCRIPT}" ` +
    `[${SENTINEL} @${ts}]`;
  const newNotes = `${existingNotes.replace(/\s+$/u, "")}${annotation}`;
  try {
    await updateListingRecord(RECORD_ID, {
      Verification_Notes: newNotes,
      Last_Outreach_Date: ts.slice(0, 10),
      Outreach_Status: "Texted",
    });
  } catch (err) {
    // Send succeeded; sentinel write failed → log loudly but do NOT retry the send.
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "outreach",
      event: "strathmoor_soft_reengage",
      status: "uncertain",
      recordId: RECORD_ID,
      externalId: sendResult.id ?? undefined,
      inputSummary: { to: phone, agent_name: AGENT_NAME, quo_status: sendResult.status, http: sendResult.httpStatus },
      outputSummary: { stage: "send_ok_sentinel_write_failed", message: "MANUAL ACTION REQUIRED — record sentinel manually to prevent re-send on next slot" },
      error: msg,
    });
    return NextResponse.json({ ok: false, error: "sentinel_write_failed_send_ok", message: msg, quo_id: sendResult.id, quo_status: sendResult.status }, { status: 500 });
  }

  await audit({
    agent: "outreach",
    event: "strathmoor_soft_reengage",
    status: "confirmed_success",
    recordId: RECORD_ID,
    externalId: sendResult.id ?? undefined,
    inputSummary: { to: phone, agent_name: AGENT_NAME, opener: 45000, ceiling: 50000, script_preview: SCRIPT.slice(0, 80) },
    outputSummary: { quo_status: sendResult.status, http: sendResult.httpStatus, duration_ms: Date.now() - t0 },
    decision: "sent",
  });

  return NextResponse.json({
    ok: true,
    status: "sent",
    quo_id: sendResult.id,
    quo_status: sendResult.status,
    to: AGENT_PHONE,
    opener: 45000,
    ceiling: 50000,
    duration_ms: Date.now() - t0,
  });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
