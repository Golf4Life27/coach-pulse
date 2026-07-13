// Quo → Verification_Notes sync cron.
// @agent: outreach
//
// For each engaged-status active listing, poll OpenPhone for inbound
// messages from the listing-agent phone since the last cron tick, and
// APPEND them VERBATIM to Verification_Notes (idempotent by Quo id).
// Runs the L3 dollar-amount detector on every appended event and
// surfaces escalations in the audit log.
//
// Why this exists (post-d38438f cycle): Burwood / Silverage / Waverly
// had live Quo replies that NEVER landed in the source-of-truth record.
// The dossier (and every downstream gate) read empty bodies and missed
// the negotiation points. This route closes the gap.
//
// Bounded: process up to LIMIT records per tick; HOURS_BACK lookback to
// catch late-arriving messages without re-paging all 90-day history.

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, updateListingRecord } from "@/lib/airtable";
import { getThreadVerified } from "@/lib/quo";
import { normalizePhone } from "@/lib/phone-normalize";
import { toE164 } from "@/lib/phone";
import { appendQuoMessagesToNotes } from "@/lib/outreach/quo-sync";
import {
  buildInboundReplyDraft,
  createReplyProposal,
  fetchPendingReplyProposalRecordIds,
} from "@/lib/inbound/reply-draft-trigger";
import { audit } from "@/lib/audit-log";
import type { Listing } from "@/lib/types";
import {
  authenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_LIMIT = 40;
const DEFAULT_HOURS_BACK = 24;
// Use the existing population window the brief detector uses (long enough
// to catch every responder that's still in an Active/Texted/Emailed state).
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

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const hoursBack = Math.max(1, Math.min(168, parseInt(url.searchParams.get("hours_back") ?? String(DEFAULT_HOURS_BACK), 10) || DEFAULT_HOURS_BACK));
  const sinceMinutes = hoursBack * 60;

  // Source population — same active-population getter the stale-triage cron uses.
  let listings: Listing[];
  try {
    listings = await getActiveListingsForBrief({ recentDays: POPULATION_RECENT_DAYS, cacheKey: `quo-sync:${POPULATION_RECENT_DAYS}d` });
  } catch (err) {
    return NextResponse.json({ ok: false, error: "population_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  const cohort = listings.slice(0, limit);

  interface RowOutcome {
    recordId: string;
    address: string;
    agent_phone: string | null;
    new_events: number;
    escalations: number;
    skipped_already_present: number;
    error?: string;
  }
  const outcomes: RowOutcome[] = [];
  let totalEscalations = 0;
  // Cross-path dedup with scan-comms (both draft SMS replies): a record that
  // already has a pending jarvis_reply proposal is skipped here so the two
  // paths never double-queue the same inbound (P2.1, 2026-07-13).
  const pendingReplyRecordIds = await fetchPendingReplyProposalRecordIds();
  let draftsQueued = 0;
  let draftsHeld = 0;

  for (const l of cohort) {
    const phone = normalizePhone((l as { agentPhone?: string | null }).agentPhone);
    if (!phone) { outcomes.push({ recordId: l.id, address: l.address, agent_phone: null, new_events: 0, escalations: 0, skipped_already_present: 0, error: "no_agent_phone" }); continue; }
    try {
      // RELIABLE READ PATH (operator brief 2026-06-07): the feed walk in
      // getMessagesForParticipant dropped two delivered 6/7 outbounds.
      // getThreadVerified uses per-ID lookup as the source of truth; any
      // feed-only / body-divergence ids land in the audit log via the
      // discrepancy fields below.
      const thread = await getThreadVerified(phone, sinceMinutes, 30);
      const msgs = thread.messages;
      if (thread.feedOnlyIds.length > 0 || thread.bodyDivergenceIds.length > 0) {
        await audit({
          agent: "outreach",
          event: "quo_feed_discrepancy",
          status: "uncertain",
          recordId: l.id,
          inputSummary: { address: l.address, agent_phone: phone },
          outputSummary: { feed_only_ids: thread.feedOnlyIds, body_divergence_ids: thread.bodyDivergenceIds },
        });
      }
      const r = appendQuoMessagesToNotes(l.notes, msgs.map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, direction: m.direction })), { syncMarkerSource: "quo_sync" });
      const fields: Record<string, unknown> = {};
      if (r.newEvents.length > 0) {
        fields["Verification_Notes"] = r.notes;

        // ── RECOMMENDED REPLIES (P2.1, 2026-07-13): the newest ingested SMS
        // inbound generates a guardrailed 2A draft (crier, SMS register) —
        // queued as a jarvis_reply proposal with a send_sms payload and
        // mirrored onto the listing for the Live Deals strip. Idempotent by
        // inbound msg id; cross-deduped against scan-comms' pending queue.
        // Guardrail failure → HOLD surfaced. Best-effort — the notes write
        // still lands even if drafting throws.
        try {
          const newest = [...r.newEvents].sort(
            (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
          )[0];
          const draft = await buildInboundReplyDraft({
            listing: {
              id: l.id,
              address: l.address,
              outreachStatus: l.outreachStatus,
              underwrittenMao: l.underwrittenMao ?? null,
              mao: l.mao ?? null,
              listPrice: l.listPrice ?? null,
              agentName: l.agentName ?? null,
              agentEmail: l.agentEmail ?? null,
              draftReplyMeta: l.draftReplyMeta ?? null,
            },
            notes: r.notes,
            inbound: { msgId: newest.id, body: newest.body, toPhoneE164: toE164(phone) },
            channel: "sms",
            hasPendingProposal: pendingReplyRecordIds.has(l.id),
          });
          if (draft.proposal) {
            const created = await createReplyProposal(draft.proposal);
            fields["Draft_Reply_Text"] = draft.draftText;
            fields["Draft_Reply_Meta"] = JSON.stringify({
              ...draft.draftMeta,
              proposal_id: created ? draft.proposal.proposalId : undefined,
            });
            if (draft.drafted) draftsQueued++;
            else draftsHeld++;
            // Once queued, guard scan-comms (and later rows) from re-drafting.
            if (created) pendingReplyRecordIds.add(l.id);
          }
        } catch (err) {
          console.error("[quo_sync] reply draft failed:", err);
        }
      }
      if (Object.keys(fields).length > 0) {
        await updateListingRecord(l.id, fields);
      }
      if (r.newEvents.length > 0 && r.escalationCount > 0) {
        await audit({
          agent: "outreach",
          event: "quo_sync_escalation",
          status: "confirmed_success",
          recordId: l.id,
          inputSummary: { address: l.address, agent_phone: phone, hours_back: hoursBack },
          outputSummary: {
            new_events: r.newEvents.length,
            escalations: r.escalationCount,
            amounts: r.newEvents.flatMap((e) => e.amounts.map((a) => a.amountUsd)),
          },
          decision: "escalate",
        });
      }
      outcomes.push({
        recordId: l.id,
        address: l.address,
        agent_phone: phone,
        new_events: r.newEvents.length,
        escalations: r.escalationCount,
        skipped_already_present: r.skippedAlreadyPresent.length,
      });
      totalEscalations += r.escalationCount;
    } catch (err) {
      outcomes.push({ recordId: l.id, address: l.address, agent_phone: phone, new_events: 0, escalations: 0, skipped_already_present: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const summary = {
    cohort_size: cohort.length,
    rows_with_new_events: outcomes.filter((r) => r.new_events > 0).length,
    total_escalations: totalEscalations,
    reply_drafts_queued: draftsQueued,
    reply_drafts_held: draftsHeld,
    errors: outcomes.filter((r) => r.error).length,
    duration_ms: Date.now() - t0,
  };
  console.log("[quo_sync]", JSON.stringify(summary).slice(0, 500));
  await audit({
    agent: "outreach",
    event: "quo_sync_sweep",
    status: "confirmed_success",
    inputSummary: { limit, hours_back: hoursBack, auth_kind: auth.kind },
    outputSummary: summary,
  });
  return NextResponse.json({ ok: true, summary, outcomes });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
