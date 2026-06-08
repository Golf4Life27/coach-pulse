// Conversation check for the unverified "Response Received" cohort.
// @agent: sentry
//
// GET /api/admin/conversation-check
//   → DRY-RUN by default. For every active listing flagged unverified
//     by lib/outreach-status-audit (reply-implying status + texted, no
//     recorded Last_Inbound_At), fetches the Quo thread for the agent
//     phone, runs the pure classifier, returns a reviewable list with
//     proposed verdicts (keep / downgrade_to_texted / downgrade_to_dead
//     / uncertain). Writes NOTHING.
//   ?apply=1&confirm=FIX-CONVERSATION-CHECK-YYYY-MM-DD
//     → applies the proposed corrections. UNCERTAIN is never auto-
//       written (no Quo data → no decision). The 5/8 unverified records
//       from the 2026-06-08 audit are the primary cohort.
//   ?lookback_days=N    (default 60) — how far back to pull the Quo
//                       thread.
//
// Designed to be cheap: only the unverified set is scanned, one Quo
// fetch per record (deduped by agent phone if multiple records share
// one agent — a single thread can verify all of them).
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { getMessagesForParticipant, type QuoMessage } from "@/lib/quo";
import {
  classifyConversation,
  type ConversationVerdict,
  type InboundCheckMessage,
} from "@/lib/conversation-check";
import { auditOutreachStatuses, type OutreachAuditInput } from "@/lib/outreach-status-audit";

export const runtime = "nodejs";
export const maxDuration = 180;

const DEFAULT_LOOKBACK_DAYS = 60;

function todayToken(now = new Date()): string {
  return `FIX-CONVERSATION-CHECK-${now.toISOString().slice(0, 10)}`;
}

interface RecordProposal {
  recordId: string;
  address: string | null;
  state: string | null;
  agentPhone: string | null;
  currentStatus: string | null;
  lastOutboundAt: string | null;
  quo_message_count: number;
  verdict: ConversationVerdict;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
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
  const apply = url.searchParams.get("apply") === "1";
  const confirm = url.searchParams.get("confirm");
  const lookbackDaysRaw = Number(url.searchParams.get("lookback_days"));
  const lookbackDays = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0
    ? Math.floor(lookbackDaysRaw)
    : DEFAULT_LOOKBACK_DAYS;
  const sinceMinutes = lookbackDays * 24 * 60;

  if (apply && confirm !== todayToken()) {
    return NextResponse.json(
      { error: "confirm_required", expected: todayToken(), note: "apply writes only the verdicts the Quo thread supports; UNCERTAIN is never auto-written" },
      { status: 409 },
    );
  }

  // ── Find the unverified cohort ───────────────────────────────────
  let listings;
  try {
    listings = await getListings({ includeLegacy: true });
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
  const auditInputs: OutreachAuditInput[] = listings.map((l) => ({
    id: l.id,
    address: l.address,
    state: l.state,
    sourceVersion: l.sourceVersion,
    outreachStatus: l.outreachStatus,
    lastInboundAt: l.lastInboundAt ?? null,
    lastOutboundAt: l.lastOutboundAt ?? null,
    executionPath: l.executionPath,
  }));
  const { findings } = auditOutreachStatuses(auditInputs);
  const unverified = findings.filter((f) => f.verdict === "unverified");

  if (unverified.length === 0) {
    return NextResponse.json({
      ok: true,
      mode: apply ? "apply" : "dry_run",
      auth_kind: authKind,
      message: "no unverified records to check",
      duration_ms: Date.now() - t0,
    });
  }

  // ── Per-record Quo fetch + classify ──────────────────────────────
  // Cache per-phone — multi-listing agents share threads.
  const threadCache = new Map<string, InboundCheckMessage[]>();
  const proposals: RecordProposal[] = [];

  for (const f of unverified) {
    const listing = listings.find((l) => l.id === f.id);
    if (!listing) continue;
    const phone = listing.agentPhone;
    if (!phone) {
      proposals.push({
        recordId: f.id,
        address: f.address,
        state: f.state,
        agentPhone: null,
        currentStatus: f.outreachStatus,
        lastOutboundAt: listing.lastOutboundAt ?? null,
        quo_message_count: 0,
        verdict: { verdict: "uncertain", reason: "no_agent_phone" },
      });
      continue;
    }
    let thread = threadCache.get(phone);
    if (!thread) {
      try {
        const messages = await getMessagesForParticipant(phone, sinceMinutes);
        thread = messages.map((m: QuoMessage) => ({
          direction: m.direction,
          body: m.body,
          createdAt: m.createdAt,
        }));
        threadCache.set(phone, thread);
      } catch (err) {
        thread = [];
        proposals.push({
          recordId: f.id,
          address: f.address,
          state: f.state,
          agentPhone: phone,
          currentStatus: f.outreachStatus,
          lastOutboundAt: listing.lastOutboundAt ?? null,
          quo_message_count: 0,
          verdict: { verdict: "uncertain", reason: `quo_error: ${String(err).slice(0, 100)}` },
        });
        continue;
      }
    }
    const verdict = classifyConversation(thread, listing.lastOutboundAt ?? null);
    proposals.push({
      recordId: f.id,
      address: f.address,
      state: f.state,
      agentPhone: phone,
      currentStatus: f.outreachStatus,
      lastOutboundAt: listing.lastOutboundAt ?? null,
      quo_message_count: thread.length,
      verdict,
    });
  }

  // ── Apply (only the decidable verdicts) ──────────────────────────
  let applied: { attempted: number; written: number; skipped: number; errors: string[] } | null = null;
  if (apply) {
    const errors: string[] = [];
    let written = 0;
    let skipped = 0;
    let attempted = 0;
    for (const p of proposals) {
      if (p.verdict.verdict === "uncertain" || p.verdict.verdict === "keep_response_received") {
        // uncertain → never write. keep → no change needed.
        skipped++;
        continue;
      }
      attempted++;
      const newStatus =
        p.verdict.verdict === "downgrade_to_texted" ? "Texted" : "Dead";
      try {
        await updateListingRecord(p.recordId, { Outreach_Status: newStatus });
        written++;
        await audit({
          agent: "sentry",
          event: "conversation_check_applied",
          status: "confirmed_success",
          recordId: p.recordId,
          inputSummary: {
            from: p.currentStatus,
            verdict: p.verdict.verdict,
            quo_message_count: p.quo_message_count,
          },
          outputSummary: { to: newStatus },
          decision: p.verdict.verdict,
        });
      } catch (err) {
        errors.push(`${p.recordId}: ${String(err).slice(0, 120)}`);
      }
    }
    applied = { attempted, written, skipped, errors };
  }

  await audit({
    agent: "sentry",
    event: "conversation_check",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, apply, lookback_days: lookbackDays, unverified_count: unverified.length },
    outputSummary: {
      verdicts: {
        keep_response_received: proposals.filter((p) => p.verdict.verdict === "keep_response_received").length,
        downgrade_to_texted: proposals.filter((p) => p.verdict.verdict === "downgrade_to_texted").length,
        downgrade_to_dead: proposals.filter((p) => p.verdict.verdict === "downgrade_to_dead").length,
        uncertain: proposals.filter((p) => p.verdict.verdict === "uncertain").length,
      },
      applied_written: applied?.written ?? 0,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    mode: apply ? "apply" : "dry_run",
    lookback_days: lookbackDays,
    unverified_count: unverified.length,
    proposals,
    applied,
    duration_ms: Date.now() - t0,
  });
}
