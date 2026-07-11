// Decision escalation over existing pipes (silver-platter cockpit).
// @agent: maverick
//
// Hourly: when a conveyor decision has REAL sourced dollars attached, has
// aged past threshold (or its real deadline is overdue), and the operator's
// server-side last-seen says he hasn't been in the cockpit — text his
// personal number ONE plain sentence with a deep link.
//
// FAIL-CLOSED everywhere:
//   - OPERATOR_PERSONAL_PHONE unset → report-only (never guesses a number).
//   - Chicago-local window 8:00–21:00 only.
//   - One text per decision per 24h (KV setNx dedupe).
//   - Max ESCALATION_MAX_PER_RUN (default 2) texts per run.
//   - Dollars are the conveyor's SOURCED figures — a fabricated $ cannot
//     exist here by construction.
// This is a UI-owned lane; it reuses lib/quo.sendMessage but touches no
// send-lane pipeline or flag.

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
import {
  composeEscalationSms,
  insideChicagoWindow,
  readEscalationConfig,
  shouldEscalate,
  OPERATOR_LAST_SEEN_KEY,
} from "@/lib/escalation";

export const runtime = "nodejs";
export const maxDuration = 60;

const BASE_URL = () => process.env.DASHBOARD_BASE_URL || "https://coach-pulse-ten.vercel.app";
const escKey = (itemKey: string) => `esc:sent:${itemKey}`;
const ESC_DEDUPE_TTL_S = 86_400;

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
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const cfg = readEscalationConfig();
  const now = new Date();
  const nowIso = now.toISOString();
  const phone = (process.env.OPERATOR_PERSONAL_PHONE ?? "").trim() || null;

  if (!insideChicagoWindow(now, cfg)) {
    return NextResponse.json({ ok: true, outcome: "outside_window", chicago_window: `${cfg.windowStartHour}-${cfg.windowEndHour}`, duration_ms: Date.now() - t0 });
  }

  let lastSeen: string | null = null;
  if (kvConfigured()) {
    lastSeen = await kvProd.get(OPERATOR_LAST_SEEN_KEY).catch(() => null);
  }

  const items = await fetchConveyorItemsServer(nowIso);
  const verdicts = items.map((item) => ({ item, verdict: shouldEscalate(item, { lastSeenIso: lastSeen, nowIso, cfg }) }));
  const due = verdicts.filter((v) => v.verdict.escalate);

  const sent: Array<{ key: string; title: string; sms: string }> = [];
  const skipped: Array<{ key: string; reason: string }> = [];

  for (const { item, verdict } of due) {
    if (sent.length >= cfg.maxPerRun) {
      skipped.push({ key: item.key, reason: "max_per_run" });
      continue;
    }
    const sms = composeEscalationSms(item, BASE_URL(), verdict.ageHours);
    if (!phone) {
      skipped.push({ key: item.key, reason: "no_operator_phone_env" });
      continue;
    }
    // One text per decision per 24h — claim BEFORE dispatch.
    if (kvConfigured()) {
      const claimed = await kvProd.setNx(escKey(item.key), nowIso, ESC_DEDUPE_TTL_S).catch(() => false);
      if (!claimed) {
        skipped.push({ key: item.key, reason: "already_escalated_24h" });
        continue;
      }
    }
    try {
      await sendMessage(phone, sms);
      sent.push({ key: item.key, title: item.title, sms });
      await audit({
        agent: "maverick",
        event: "decision_escalation_sent",
        status: "confirmed_success",
        recordId: item.recordId ?? undefined,
        inputSummary: { key: item.key, dollars: item.dollars, age_hours: verdict.ageHours, reason: verdict.reason },
        outputSummary: { sms },
      });
    } catch (err) {
      // Release the claim so the next hourly run retries.
      if (kvConfigured()) await kvProd.del(escKey(item.key)).catch(() => {});
      skipped.push({ key: item.key, reason: `send_failed: ${String(err).slice(0, 120)}` });
    }
  }

  await audit({
    agent: "maverick",
    event: "decision_escalation_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, operator_last_seen: lastSeen, phone_configured: phone != null },
    outputSummary: { items: items.length, due: due.length, sent: sent.length, skipped: skipped.length },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    mode: phone ? "live" : "report_only_no_phone",
    operator_last_seen: lastSeen,
    items_considered: items.length,
    due: due.map((d) => ({ key: d.item.key, title: d.item.title, dollars: d.item.dollars, reason: d.verdict.reason })),
    sent,
    skipped,
    duration_ms: Date.now() - t0,
  });
}
