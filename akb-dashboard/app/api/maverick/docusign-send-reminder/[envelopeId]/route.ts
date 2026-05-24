// Maverick DocuSign send-reminder endpoint (Phase 5.3).
// @agent: scribe
//
// User-triggered: the ScribeDealCommentary panel surfaces a "Send
// reminder" button when an envelope is in-flight and awaiting a
// recipient. POST here invokes `sendReminder` against DocuSign with
// dashboard-session auth (no polling, no cron — mirrors Phase 11.6/
// 11.7 discipline).
//
// Returns:
//   200 { ok, http_status, raw } on success
//   401 { error: "unauthorized" } when caller is unauthenticated
//   503 { error: "docusign_not_configured" } when DOCUSIGN_* env
//     vars are missing — surfaces cleanly to the UI
//   500 { error, message } on DocuSign API failure (audited)

import { NextResponse } from "next/server";
import { sendReminder, docusignConfigured } from "@/lib/docusign";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ envelopeId: string }> },
) {
  const t0 = Date.now();
  const { envelopeId } = await params;

  if (!envelopeId || envelopeId.length < 8) {
    return NextResponse.json({ error: "invalid_envelope_id" }, { status: 400 });
  }

  // Auth — dashboard session first, OAuth waterfall fallback. Same
  // pattern as load-state / recall.
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

  // Cron callers are off-by-default here — reminders should only fire
  // from user actions. Defense-in-depth with the existing Phase 11.6
  // global cron gate.
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json(
      { error: "cron_disabled" },
      { status: 503 },
    );
  }

  if (!docusignConfigured()) {
    return NextResponse.json(
      { error: "docusign_not_configured" },
      { status: 503 },
    );
  }

  try {
    const result = await sendReminder(envelopeId);
    await audit({
      agent: "scribe",
      event: "envelope_reminder_sent",
      status: result.ok ? "confirmed_success" : "confirmed_failure",
      inputSummary: { envelope_id: envelopeId, auth_kind: authKind },
      outputSummary: { http_status: result.httpStatus },
      externalId: envelopeId,
      ms: Date.now() - t0,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "scribe",
      event: "envelope_reminder_failed",
      status: "confirmed_failure",
      inputSummary: { envelope_id: envelopeId, auth_kind: authKind },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { error: "send_reminder_failed", message: msg },
      { status: 500 },
    );
  }
}
