// Gmail → Verification_Notes sync cron (M6 Part 1 — email channel).
// @agent: outreach
//
// The email twin of quo-sync. THE GAP (M6 Part 0): agent email replies were
// fetched only ephemerally for gate classification and NEVER written to the
// record — no Gmail equivalent of quo-sync. This closes it: for each engaged
// listing with an agentEmail, fetch the thread and APPEND verbatim INBOUND
// email to Verification_Notes (idempotent by Gmail id), so the dossier reads
// email replies the same way it reads SMS.
//
// GATED DARK: behind INBOUND_CAPTURE_LIVE (default OFF) — watched-first. OFF ⇒
// returns immediately, writes nothing (zero behavior change). The operator
// flips the flag after reviewing the watched run.

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, updateListingRecord } from "@/lib/airtable";
import { getThreadsForEmail } from "@/lib/gmail";
import { appendGmailMessagesToNotes } from "@/lib/inbound/gmail-capture";
import { isInboundCaptureLive } from "@/lib/inbound/flag";
import { audit } from "@/lib/audit-log";
import type { Listing } from "@/lib/types";
import { authenticate, readAuthEnv, readAuthHeaders } from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_LIMIT = 40;
const DEFAULT_HOURS_BACK = 48;
const POPULATION_RECENT_DAYS = 365;

async function handle(req: Request) {
  const t0 = Date.now();
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
  if (auth.kind !== "cron" && auth.kind !== "oauth") {
    return NextResponse.json({ error: "unauthorized", reason: "unsupported_auth_kind" }, { status: 401 });
  }
  if (auth.kind === "oauth" && !kvConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 500 });
  }

  // WATCHED-FIRST: until the operator flips INBOUND_CAPTURE_LIVE, this cron is
  // a no-op (it never writes email into the record).
  if (!isInboundCaptureLive()) {
    return NextResponse.json({ ok: true, watched: true, reason: "INBOUND_CAPTURE_LIVE not set — no writes" });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const hoursBack = Math.max(1, Math.min(168, parseInt(url.searchParams.get("hours_back") ?? String(DEFAULT_HOURS_BACK), 10) || DEFAULT_HOURS_BACK));
  const sinceMinutes = hoursBack * 60;
  const ourAddress = process.env.GMAIL_FROM_ADDRESS || "alex@akb-properties.com";

  let listings: Listing[];
  try {
    listings = await getActiveListingsForBrief({ recentDays: POPULATION_RECENT_DAYS, cacheKey: `gmail-sync:${POPULATION_RECENT_DAYS}d` });
  } catch (err) {
    return NextResponse.json({ ok: false, error: "population_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  const cohort = listings.filter((l) => (l as { agentEmail?: string | null }).agentEmail).slice(0, limit);

  interface RowOutcome { recordId: string; address: string; agent_email: string | null; new_events: number; escalations: number; error?: string }
  const outcomes: RowOutcome[] = [];
  let totalEscalations = 0;

  for (const l of cohort) {
    const email = ((l as { agentEmail?: string | null }).agentEmail ?? "").trim();
    if (!email) continue;
    try {
      const msgs = await getThreadsForEmail(email, sinceMinutes);
      const r = appendGmailMessagesToNotes(
        l.notes,
        msgs.map((m) => ({ id: m.id, from: m.from, body: m.body, date: m.date })),
        ourAddress,
        { syncMarkerSource: "gmail_sync" },
      );
      if (r.newEvents.length > 0) {
        await updateListingRecord(l.id, { Verification_Notes: r.notes });
        if (r.escalationCount > 0) {
          await audit({
            agent: "outreach",
            event: "gmail_sync_escalation",
            status: "confirmed_success",
            recordId: l.id,
            inputSummary: { address: l.address, agent_email: email, hours_back: hoursBack },
            outputSummary: { new_events: r.newEvents.length, escalations: r.escalationCount, amounts: r.newEvents.flatMap((e) => e.amounts.map((a) => a.amountUsd)) },
            decision: "escalate",
          });
        }
      }
      outcomes.push({ recordId: l.id, address: l.address, agent_email: email, new_events: r.newEvents.length, escalations: r.escalationCount });
      totalEscalations += r.escalationCount;
    } catch (err) {
      outcomes.push({ recordId: l.id, address: l.address, agent_email: email, new_events: 0, escalations: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const summary = {
    cohort_size: cohort.length,
    rows_with_new_events: outcomes.filter((r) => r.new_events > 0).length,
    total_escalations: totalEscalations,
    errors: outcomes.filter((r) => r.error).length,
    duration_ms: Date.now() - t0,
  };
  console.log("[gmail_sync]", JSON.stringify(summary).slice(0, 500));
  await audit({
    agent: "outreach",
    event: "gmail_sync_sweep",
    status: "confirmed_success",
    inputSummary: { limit, hours_back: hoursBack, auth_kind: auth.kind },
    outputSummary: summary,
  });
  return NextResponse.json({ ok: true, summary, outcomes });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
