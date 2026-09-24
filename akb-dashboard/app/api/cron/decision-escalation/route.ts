// Decision escalation over existing pipes (silver-platter cockpit).
// @agent: maverick
//
// Hourly: when a conveyor decision has REAL sourced dollars attached, has
// aged past threshold (or its real deadline is overdue), and the operator's
// server-side last-seen says he hasn't been in the cockpit — text his
// personal number ONE plain sentence with a deep link.
//
// FAIL-CLOSED everywhere:
//   - Phone resolution goes through the SAME waterfall operator-page uses
//     (resolveOperatorPhone: ALERT_PHONE -> OPERATOR_PERSONAL_PHONE ->
//     MAVERICK_STAGE4_SMS_TARGET -> the operator-confirmed default cell).
//     P0-17 (2026-09-24): this cron read ONLY OPERATOR_PERSONAL_PHONE and
//     that var was never set in prod, so 32 overdue decisions accrued with
//     phone_configured:false and zero texts sent while the operator-page
//     path (same phone, different resolver) was sending fine.
//   - Chicago-local window 8:00–21:00 only.
//   - ONE digest text per run, not one per decision (P0-17 follow-up,
//     2026-09-24 — the resolver fix above meant every one of ~32 overdue
//     decisions would otherwise fire its own text, hourly, 8am-9pm: noise
//     on top of the hourly triage routine that already covers the live
//     ones). Every due decision not already claimed within the last 24h
//     (KV setNx dedupe, unchanged) is claimed and folded into ONE SMS
//     naming the top 3 + a count of the rest. A send failure releases every
//     claim taken this run so the next run retries all of them.
//   - cfg.maxPerRun no longer caps anything here (a digest is always at
//     most one text) — the field stays in EscalationConfig because
//     app/api/cron/accepted-silence/route.ts still reads it.
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
import { resolveOperatorPhone } from "@/lib/maverick/operator-page";
import {
  composeEscalationDigestSms,
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
  // Same resolver operator-page uses (P0-17) — so this cron sends whenever
  // the operator-page path would, instead of hard-depending on a single var.
  const phone = resolveOperatorPhone(process.env as Record<string, string | undefined>).trim() || null;

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

  // Fail-closed BEFORE claiming anything — a run that cannot deliver must
  // never spend the 24h dedupe budget on decisions it never told anyone about.
  if (!phone) {
    for (const { item } of due) skipped.push({ key: item.key, reason: "no_operator_phone_env" });
    await audit({
      agent: "maverick",
      event: "decision_escalation_run",
      status: "confirmed_success",
      inputSummary: { auth_kind: authKind, operator_last_seen: lastSeen, phone_configured: false },
      outputSummary: { items: items.length, due: due.length, sent: 0, skipped: skipped.length, outcome: "no_phone" },
      ms: Date.now() - t0,
    });
    return NextResponse.json({
      ok: true,
      mode: "report_only_no_phone",
      outcome: "no_phone",
      operator_last_seen: lastSeen,
      items_considered: items.length,
      due: due.map((d) => ({ key: d.item.key, title: d.item.title, dollars: d.item.dollars, reason: d.verdict.reason })),
      sent,
      skipped,
      duration_ms: Date.now() - t0,
    });
  }

  // Collect + claim EVERY due decision not already escalated in the last
  // 24h (same escKey / setNx dedupe as before) — one claim pass, no send
  // yet. Without KV there is no dedupe store, so every due item is "new"
  // this run (same fail-open-without-KV posture the route always had).
  const claimed: typeof due = [];
  for (const { item, verdict } of due) {
    if (kvConfigured()) {
      const ok = await kvProd.setNx(escKey(item.key), nowIso, ESC_DEDUPE_TTL_S).catch(() => false);
      if (!ok) {
        skipped.push({ key: item.key, reason: "already_escalated_24h" });
        continue;
      }
    }
    claimed.push({ item, verdict });
  }

  let outcome: "nothing_new" | "sent" | "send_failed" = "nothing_new";

  if (claimed.length > 0) {
    const sms = composeEscalationDigestSms(
      claimed.map(({ item }) => ({ title: item.title, dollars: item.dollars })),
      BASE_URL(),
    );
    try {
      await sendMessage(phone, sms);
      outcome = "sent";
      for (const { item } of claimed) sent.push({ key: item.key, title: item.title, sms });
      await audit({
        agent: "maverick",
        event: "decision_escalation_sent",
        status: "confirmed_success",
        inputSummary: {
          keys: claimed.map(({ item }) => item.key),
          dollars: claimed.map(({ item }) => item.dollars),
          count: claimed.length,
        },
        outputSummary: { sms },
      });
    } catch (err) {
      outcome = "send_failed";
      // Release every claim taken THIS run so the next run retries all of
      // them — a digest is one delivery; a partial claim with no delivery
      // is worse than no claim (the next run would silently skip it).
      if (kvConfigured()) {
        await Promise.all(claimed.map(({ item }) => kvProd.del(escKey(item.key)).catch(() => {})));
      }
      const reason = `send_failed: ${String(err).slice(0, 120)}`;
      for (const { item } of claimed) skipped.push({ key: item.key, reason });
    }
  }

  await audit({
    agent: "maverick",
    event: "decision_escalation_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, operator_last_seen: lastSeen, phone_configured: true },
    outputSummary: { items: items.length, due: due.length, sent: sent.length, skipped: skipped.length, outcome },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    mode: "live",
    outcome,
    operator_last_seen: lastSeen,
    items_considered: items.length,
    due: due.map((d) => ({ key: d.item.key, title: d.item.title, dollars: d.item.dollars, reason: d.verdict.reason })),
    sent,
    skipped,
    duration_ms: Date.now() - t0,
  });
}
