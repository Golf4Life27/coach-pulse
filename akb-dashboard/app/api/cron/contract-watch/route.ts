// Contract watchdog cron — page the operator while an envelope waits on HIS signature.
// @agent: scribe
//
// 513 Lamar sat three days with the seller already signed and Alex as the only
// remaining signer. Four agent follow-ups, two DocuSign resends, and nothing in
// the system noticed — see lib/contract-watch.ts for why every existing lane
// was blind to it.
//
// Same auth waterfall + kill switch + KV dedupe + dry_run shape as
// app/api/cron/option-tripwire/route.ts, and the same FAIL-CLOSED posture on
// the phone: no OPERATOR_PERSONAL_PHONE means the run still reports what is
// pending, it just cannot text.
//
// DEDUPE IS PER (envelope, UTC day): this nags ONCE A DAY per envelope for as
// long as it is unsigned, rather than once ever. An unsigned contract does not
// stop being urgent because we already mentioned it — that is the exact
// failure being fixed. Signing it (or DocuSign's "Completed:" notice) is what
// stops the nagging.
//
// NOT gated behind INBOUND_CAPTURE_LIVE. That flag guards writing inbound mail
// into Verification_Notes; this route writes nothing to Airtable and only
// reads DocuSign's own notifications. Coupling it to a dark flag would
// reproduce the miss.

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
import { getThreadsForEmail } from "@/lib/gmail";
import { composeContractWatchSms, findPendingSignatures } from "@/lib/contract-watch";

export const runtime = "nodejs";
export const maxDuration = 60;

// DocuSign's notification sender. getThreadsForEmail matches from/to/cc, so
// this pulls every envelope notice the operator has received.
const DOCUSIGN_SENDER = "dse@docusign.net";
const LOOKBACK_DAYS = 30;
const DEFAULT_MIN_AGE_HOURS = 24;
const CLAIM_TTL_SECONDS = 36 * 3_600; // > 1 day so the daily claim cannot double-fire

async function claimKey(key: string): Promise<boolean> {
  if (!kvConfigured()) return true; // no KV — best-effort dev/CI posture, same as option-tripwire
  try {
    return await kvProd.setNx(key, "1", CLAIM_TTL_SECONDS);
  } catch (err) {
    console.error("[contract-watch] KV claim failed, treating as unclaimed:", key, err);
    return true;
  }
}

async function sendSms(phone: string, sms: string): Promise<boolean> {
  try {
    await sendMessage(phone, sms);
    return true;
  } catch (err) {
    console.error("[contract-watch] SMS send failed:", err);
    return false;
  }
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const minAgeHours = Number(url.searchParams.get("min_age_hours") ?? DEFAULT_MIN_AGE_HOURS);
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

  const now = new Date();
  const phone = (process.env.OPERATOR_PERSONAL_PHONE ?? "").trim() || null;

  let messages: Awaited<ReturnType<typeof getThreadsForEmail>> = [];
  try {
    messages = await getThreadsForEmail(DOCUSIGN_SENDER, LOOKBACK_DAYS * 24 * 60);
  } catch (err) {
    await audit({
      agent: "scribe",
      event: "contract_watch_run",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind, dry_run: dryRun },
      error: String(err).slice(0, 300),
      ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json({ error: "gmail_read_failed", detail: String(err).slice(0, 200) }, { status: 502 });
  }

  const pending = findPendingSignatures(messages, now);
  const due = pending.filter((e) => e.ageHours >= minAgeHours);

  const fired: Array<{ label: string; age_hours: number; notices: number; sms: string; sms_sent: boolean }> = [];
  const skippedAlreadyClaimed: Array<{ label: string; age_hours: number }> = [];

  const dayBucket = now.toISOString().slice(0, 10);
  for (const env of due) {
    const key = `contract-watch:${dayBucket}:${env.label.toLowerCase().replace(/\s+/g, "-")}`;
    if (!dryRun && !(await claimKey(key))) {
      skippedAlreadyClaimed.push({ label: env.label, age_hours: env.ageHours });
      continue;
    }
    const sms = composeContractWatchSms(env);
    const smsSent = !dryRun && phone != null ? await sendSms(phone, sms) : false;
    fired.push({ label: env.label, age_hours: env.ageHours, notices: env.noticeCount, sms, sms_sent: smsSent });
  }

  await audit({
    agent: "scribe",
    event: "contract_watch_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, dry_run: dryRun, phone_configured: phone != null, min_age_hours: minAgeHours },
    outputSummary: {
      docusign_messages: messages.length,
      pending: pending.length,
      due: due.length,
      fired: fired.length,
      skipped_already_claimed: skippedAlreadyClaimed.length,
    },
    ms: Date.now() - t0,
  }).catch((err) => console.error("[contract-watch] audit write failed:", err));

  return NextResponse.json({
    ok: true,
    docusign_messages: messages.length,
    pending,
    fired,
    skipped_already_claimed: skippedAlreadyClaimed,
    dry_run: dryRun,
    duration_ms: Date.now() - t0,
  });
}
