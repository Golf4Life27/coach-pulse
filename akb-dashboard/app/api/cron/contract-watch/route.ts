// Contract watchdog cron — page the operator while an envelope waits on HIS signature.
// @agent: scribe
//
// 513 Lamar sat three days with the seller already signed and Alex as the only
// remaining signer. Four agent follow-ups, two DocuSign resends, and nothing in
// the system noticed — see lib/contract-watch.ts for why every existing lane
// was blind to it.
//
// TWO SENDERS (2026-09-12). Reading DocuSign alone was still blind: the
// Birmingham contract (1005 2nd St, agent Pamela Calamusa) is on AUTHENTISIGN.
// Both inboxes are read every run and merged (deduped by Gmail message id).
// If ONE fetch fails the other is still processed and the failure lands in the
// audit as `fetch_errors`; only a BOTH-failed run returns 502. A single dead
// platform must not blind the watchdog to the other.
//
// CHANNEL SEPARATION (operator 2026-06-10, same rule as lib/reply-alert.ts
// sendAlertSms). This nag is OPERATOR-facing, so it sends FROM the dedicated
// Maverick line (ALERT_FROM env). lib/quo.sendMessage defaults `from` to
// QUO_PHONE_ID — the AGENT-FACING outreach line — so omitting it (the bug
// through 2026-09-11) put an internal nag on the line listing agents see.
// When ALERT_FROM is unset the send REFUSES rather than falling back: the run
// still reports what is pending, with sms_sent:false and
// sms_skip_reason:"alert_from_not_set". Recipient is OPERATOR_PERSONAL_PHONE,
// falling back to ALERT_PHONE (both are operator numbers — the route used to
// go silent when only ALERT_PHONE was configured).
//
// Same auth waterfall + kill switch + KV dedupe + dry_run shape as
// app/api/cron/option-tripwire/route.ts, and the same FAIL-CLOSED posture on
// the phone: no operator number means the run still reports what is pending,
// it just cannot text.
//
// DEDUPE IS PER (envelope, UTC day): this nags ONCE A DAY per envelope for as
// long as it is unsigned, rather than once ever. An unsigned contract does not
// stop being urgent because we already mentioned it — that is the exact
// failure being fixed. Signing it (or the platform's completion notice) is
// what stops the nagging.
//
// NOT gated behind INBOUND_CAPTURE_LIVE. That flag guards writing inbound mail
// into Verification_Notes; this route writes nothing to Airtable and only
// reads the e-sign platforms' own notifications. Coupling it to a dark flag
// would reproduce the miss.

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
import { getThreadsForEmail, type GmailMessage } from "@/lib/gmail";
import { composeContractWatchSms, findPendingSignatures } from "@/lib/contract-watch";

export const runtime = "nodejs";
export const maxDuration = 60;

// The two notification senders. getThreadsForEmail matches from/to/cc, so each
// pulls every envelope notice the operator has received from that platform.
const DOCUSIGN_SENDER = "dse@docusign.net";
const AUTHENTISIGN_SENDER = "secure@authentisign.com";
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

/** Always with an explicit `from` — see CHANNEL SEPARATION above. */
async function sendSms(phone: string, sms: string, from: string): Promise<boolean> {
  try {
    await sendMessage(phone, sms, { from });
    return true;
  } catch (err) {
    console.error("[contract-watch] SMS send failed:", err);
    return false;
  }
}

async function fetchSender(sender: string): Promise<{ messages: GmailMessage[]; error: string | null }> {
  try {
    return { messages: await getThreadsForEmail(sender, LOOKBACK_DAYS * 24 * 60), error: null };
  } catch (err) {
    console.error(`[contract-watch] gmail read failed for ${sender}:`, err);
    return { messages: [], error: String(err).slice(0, 200) };
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
  // Both are operator numbers; prefer the personal line, fall back to ALERT_PHONE.
  const phone =
    (process.env.OPERATOR_PERSONAL_PHONE ?? "").trim() || (process.env.ALERT_PHONE ?? "").trim() || null;
  const alertFrom = (process.env.ALERT_FROM ?? "").trim() || null;

  const [docusign, authentisign] = await Promise.all([
    fetchSender(DOCUSIGN_SENDER),
    fetchSender(AUTHENTISIGN_SENDER),
  ]);
  const fetchErrors = [
    ...(docusign.error ? [{ sender: DOCUSIGN_SENDER, error: docusign.error }] : []),
    ...(authentisign.error ? [{ sender: AUTHENTISIGN_SENDER, error: authentisign.error }] : []),
  ];
  if (fetchErrors.length === 2) {
    await audit({
      agent: "scribe",
      event: "contract_watch_run",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind, dry_run: dryRun },
      outputSummary: { fetch_errors: fetchErrors },
      error: fetchErrors.map((f) => `${f.sender}: ${f.error}`).join(" | ").slice(0, 300),
      ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json({ error: "gmail_read_failed", fetch_errors: fetchErrors }, { status: 502 });
  }

  // Dedupe by Gmail message id — a notice addressed to both senders' threads
  // must not double-count as two notices and inflate the chase count.
  const byId = new Map<string, GmailMessage>();
  for (const m of [...docusign.messages, ...authentisign.messages]) {
    if (m?.id && !byId.has(m.id)) byId.set(m.id, m);
  }
  const messages = [...byId.values()];

  const pending = findPendingSignatures(messages, now);
  const due = pending.filter((e) => e.ageHours >= minAgeHours);

  if (due.length > 0 && !dryRun && alertFrom == null) {
    console.error(
      "[contract-watch] ALERT_FROM not set — refusing to send from the agent-facing outreach line (channel separation). Pending envelopes were NOT texted:",
      due.map((e) => e.label),
    );
  }

  const fired: Array<{
    label: string;
    platform: string;
    age_hours: number;
    notices: number;
    sms: string;
    sms_sent: boolean;
    sms_skip_reason: string | null;
  }> = [];
  const skippedAlreadyClaimed: Array<{ label: string; age_hours: number }> = [];

  const dayBucket = now.toISOString().slice(0, 10);
  for (const env of due) {
    const key = `contract-watch:${dayBucket}:${env.label.toLowerCase().replace(/\s+/g, "-")}`;
    if (!dryRun && !(await claimKey(key))) {
      skippedAlreadyClaimed.push({ label: env.label, age_hours: env.ageHours });
      continue;
    }
    const sms = composeContractWatchSms(env);

    let smsSent = false;
    let smsSkipReason: string | null = null;
    if (dryRun) smsSkipReason = "dry_run";
    else if (phone == null) smsSkipReason = "operator_phone_not_set";
    else if (alertFrom == null) smsSkipReason = "alert_from_not_set";
    else {
      smsSent = await sendSms(phone, sms, alertFrom);
      if (!smsSent) smsSkipReason = "send_failed";
    }

    fired.push({
      label: env.label,
      platform: env.platform,
      age_hours: env.ageHours,
      notices: env.noticeCount,
      sms,
      sms_sent: smsSent,
      sms_skip_reason: smsSkipReason,
    });
  }

  await audit({
    agent: "scribe",
    event: "contract_watch_run",
    status: "confirmed_success",
    inputSummary: {
      auth_kind: authKind,
      dry_run: dryRun,
      phone_configured: phone != null,
      alert_from_configured: alertFrom != null,
      min_age_hours: minAgeHours,
    },
    outputSummary: {
      docusign_messages: docusign.messages.length,
      authentisign_messages: authentisign.messages.length,
      unique_messages: messages.length,
      fetch_errors: fetchErrors,
      pending: pending.length,
      due: due.length,
      fired: fired.length,
      sms_sent: fired.filter((f) => f.sms_sent).length,
      skipped_already_claimed: skippedAlreadyClaimed.length,
    },
    ms: Date.now() - t0,
  }).catch((err) => console.error("[contract-watch] audit write failed:", err));

  return NextResponse.json({
    ok: true,
    docusign_messages: docusign.messages.length,
    authentisign_messages: authentisign.messages.length,
    unique_messages: messages.length,
    fetch_errors: fetchErrors,
    alert_from_configured: alertFrom != null,
    pending,
    fired,
    skipped_already_claimed: skippedAlreadyClaimed,
    dry_run: dryRun,
    duration_ms: Date.now() - t0,
  });
}
