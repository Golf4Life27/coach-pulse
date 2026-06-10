// Tier 1 alert smoke test (operator 2026-06-10). @agent: crier
//
// GET /api/admin/test-reply-alert
//   default                      → dry-run: compose the alert, return the
//                                  body, send NOTHING.
//   ?apply=1&confirm=TEST-REPLY-ALERT-YYYY-MM-DD
//                                → send the SMS to ALERT_PHONE.
//   ?tier=tier_1|tier_2          → which tier to synthesize (default tier_1).
//   ?record_id=rec…              → subject record (default Tracey,
//                                  recVOZVgXT0GPenAt — live cohort, captured
//                                  opener $48,750, MAO $50,000).
//
// Purpose: validate the Tier 1 decision-alert format END TO END on Alex's
// phone before the H2 cron aperture opens. The synthesized alert composes
// from the REAL record (live opener + MAO read via getListing), so the body
// Alex receives is exactly what a real counter would produce. Gated like
// outreach-batch: auth waterfall + dated confirm token + apply flag.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { buildReplyAlertBody, sendReplyAlert, type ReplyAlertInput } from "@/lib/reply-alert";
import type { AlertTier } from "@/lib/reply-triage";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_RECORD = "recVOZVgXT0GPenAt"; // 15864 Tracey St — live cohort

function todayToken(now: Date = new Date()): string {
  return `TEST-REPLY-ALERT-${now.toISOString().slice(0, 10)}`;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) authKind = "dashboard_session";
  else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }

  const url = new URL(req.url);
  const applyRequested = url.searchParams.get("apply") === "1";
  const confirm = url.searchParams.get("confirm");
  const live = applyRequested && confirm === todayToken();
  const tierParam = url.searchParams.get("tier");
  const tier: AlertTier = tierParam === "tier_2" || tierParam === "tier_2_urgent" ? "tier_2_urgent" : "tier_1_decision";
  const recordId = url.searchParams.get("record_id") ?? DEFAULT_RECORD;

  const listing = await getListing(recordId).catch(() => null);
  if (!listing) return NextResponse.json({ error: "record_not_found", recordId }, { status: 404 });

  // Synthesize the alert input from the REAL record: a counter for tier 1
  // (exercises the recommend-with-numbers path against the live opener/MAO),
  // an acceptance for tier 2.
  const input: ReplyAlertInput = {
    recordId: listing.id,
    address: listing.address ?? null,
    tier,
    classification: tier === "tier_2_urgent" ? "acceptance" : "counter",
    outreachOfferPrice: listing.outreachOfferPrice ?? null,
    underwrittenMao: listing.underwrittenMao ?? null,
  };
  const composed = buildReplyAlertBody(input);

  if (!live) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      detail: `No SMS sent. To send: ?apply=1&confirm=${todayToken()} (requires ALERT_PHONE set in env).`,
      tier,
      record: { recordId: listing.id, address: listing.address, outreachOfferPrice: listing.outreachOfferPrice ?? null, underwrittenMao: listing.underwrittenMao ?? null },
      composed_body: composed.body,
      price_gap: composed.priceGap,
      alert_phone_set: Boolean((process.env.ALERT_PHONE ?? "").trim()),
      auth_kind: authKind,
      duration_ms: Date.now() - t0,
    });
  }

  const result = await sendReplyAlert(input);
  await audit({
    agent: "crier",
    event: "reply_alert_smoke_test",
    status: result.sent ? "confirmed_success" : "confirmed_failure",
    recordId: listing.id,
    inputSummary: { tier, auth_kind: authKind },
    outputSummary: { sent: result.sent, reason: result.reason, price_gap: result.priceGap },
  });

  return NextResponse.json({
    ok: result.sent,
    mode: "live",
    tier,
    sent: result.sent,
    reason: result.reason,
    composed_body: composed.body,
    price_gap: result.priceGap,
    detail: result.sent
      ? "SMS sent to ALERT_PHONE. When Alex confirms receipt + format, the H2 cron aperture can open."
      : "Send failed — see reason.",
    duration_ms: Date.now() - t0,
  });
}
