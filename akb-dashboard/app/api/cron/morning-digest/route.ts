// The single 8:30am digest (silver-platter cockpit): decisions waiting,
// $ at stake, belt status — one SMS to the operator's personal number.
// @agent: maverick
//
// FAIL-CLOSED: no OPERATOR_PERSONAL_PHONE → report-only. KV setNx daily
// dedupe so a redeploy/re-run can never double-text. Dollars are the
// conveyor's sourced figures only.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { sendMessage } from "@/lib/quo";
import { fetchConveyorItemsServer } from "@/lib/decision-feed-server";
import { composeDigestSms, type DigestBelt } from "@/lib/escalation";

export const runtime = "nodejs";
export const maxDuration = 60;

const BASE_URL = () => process.env.DASHBOARD_BASE_URL || "https://coach-pulse-ten.vercel.app";

async function fetchBelt(origin: string, cookie: string | null, authorization: string | null): Promise<DigestBelt | null> {
  try {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (authorization) headers.authorization = authorization;
    const res = await fetch(`${origin}/api/maverick/heartbeat`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      intakeFreshness: d.heartbeats?.intake?.freshness ?? null,
      sendFreshness: d.heartbeats?.send?.freshness ?? null,
      sentYesterday: d.stations?.sent?.yesterday ?? null,
      repliesYesterday: d.stations?.replies?.yesterday ?? null,
    };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
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
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const nowIso = new Date().toISOString();
  const phone = (process.env.OPERATOR_PERSONAL_PHONE ?? "").trim() || null;

  const [items, belt] = await Promise.all([
    fetchConveyorItemsServer(nowIso),
    fetchBelt(`${url.protocol}//${url.host}`, cookieHeader, req.headers.get("authorization")),
  ]);
  const sms = composeDigestSms(items, belt, BASE_URL());

  let sent = false;
  let skipReason: string | null = null;
  if (!phone) {
    skipReason = "no_operator_phone_env";
  } else {
    // One digest per Chicago day.
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    if (kvConfigured()) {
      const claimed = await kvProd.setNx(`digest:sent:${day}`, nowIso, 2 * 86_400).catch(() => false);
      if (!claimed) skipReason = "already_sent_today";
    }
    if (!skipReason) {
      try {
        await sendMessage(phone, sms);
        sent = true;
      } catch (err) {
        skipReason = `send_failed: ${String(err).slice(0, 120)}`;
      }
    }
  }

  await audit({
    agent: "maverick",
    event: "morning_digest_run",
    status: sent || skipReason === "no_operator_phone_env" || skipReason === "already_sent_today" ? "confirmed_success" : "uncertain",
    inputSummary: { auth_kind: authKind, phone_configured: phone != null },
    outputSummary: { sent, skip_reason: skipReason, items: items.length, sms },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    mode: phone ? "live" : "report_only_no_phone",
    sent,
    skip_reason: skipReason,
    sms,
    items_waiting: items.length,
    duration_ms: Date.now() - t0,
  });
}
