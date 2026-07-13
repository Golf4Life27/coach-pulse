// Gmail → Verification_Notes sync cron (M6 Part 1 — email channel).
// @agent: outreach
//
// The email twin of quo-sync. For each syncable listing, fetch (a) threads
// matching the agent's email AND (b) every LINKED deal thread by id
// (Listings_V1.Gmail_Thread_Ids), then APPEND verbatim INBOUND email to
// Verification_Notes (idempotent by Gmail id) and stamp Last_Inbound_At
// forward. Newly-seen thread ids are persisted back to the listing, so a
// deal thread only has to be found ONCE — after that, capture survives
// CC-only recipients, new senders (TC/co-agent), and Re:→Fwd: subject
// mutations (the 3123 Sunbeam miss, spine rec17krmeSuttdyNy).
//
// COHORT (the actual Sunbeam root cause): the population is larger than one
// run's `limit`, and the old code sliced an UNSORTED prefix — same 40 rows
// every run, everything else silently starved. Now: live-money statuses
// (Negotiating/Response Received/Counter Received/Offer Accepted) are ALWAYS
// in the cohort; the remainder rotates by run-hour so coverage is bounded,
// and the audit reports population/truncation so silent starvation is
// impossible.
//
// GATED DARK: behind INBOUND_CAPTURE_LIVE (default OFF) — watched-first. OFF ⇒
// returns immediately, writes nothing (zero behavior change).

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, updateListingRecord } from "@/lib/airtable";
import { getThreadsForEmail, getThreadById, type GmailMessage } from "@/lib/gmail";
import { appendGmailMessagesToNotes, newestInboundIso } from "@/lib/inbound/gmail-capture";
import { mergeThreadIds, parseThreadIds, selectSweepCohort } from "@/lib/inbound/gmail-thread-link";
import { isInboundCaptureLive } from "@/lib/inbound/flag";
import { audit } from "@/lib/audit-log";
import type { Listing } from "@/lib/types";
import { authenticate, readAuthEnv, readAuthHeaders } from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { buildInboundReplyDraft, createReplyProposal } from "@/lib/inbound/reply-draft-trigger";

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_LIMIT = 40;
const DEFAULT_HOURS_BACK = 48;
const MAX_HOURS_BACK = 24 * 14; // backfill sweeps may reach 14 days
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
  const hoursBack = Math.max(1, Math.min(MAX_HOURS_BACK, parseInt(url.searchParams.get("hours_back") ?? String(DEFAULT_HOURS_BACK), 10) || DEFAULT_HOURS_BACK));
  const sinceMinutes = hoursBack * 60;
  const sinceMs = Date.now() - sinceMinutes * 60_000;
  const ourAddress = process.env.GMAIL_FROM_ADDRESS || "alex@akb-properties.com";

  let listings: Listing[];
  try {
    listings = await getActiveListingsForBrief({ recentDays: POPULATION_RECENT_DAYS, cacheKey: `gmail-sync:${POPULATION_RECENT_DAYS}d` });
  } catch (err) {
    return NextResponse.json({ ok: false, error: "population_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  // Live-money always syncs; the rest rotates by run-hour (bounded staleness).
  const selection = selectSweepCohort(
    listings.map((l) => ({
      id: l.id,
      status: l.outreachStatus,
      syncable: Boolean((l.agentEmail ?? "").trim() || parseThreadIds(l.gmailThreadIds).length > 0),
      lastActivityAt:
        [l.lastInboundAt, l.lastOutboundAt].filter(Boolean).sort().pop() ?? null,
      listing: l,
    })),
    limit,
    Math.floor(Date.now() / 3_600_000),
  );
  const cohort = selection.cohort.map((c) => (c as unknown as { listing: Listing }).listing);

  interface RowOutcome {
    recordId: string;
    address: string;
    agent_email: string | null;
    linked_threads: number;
    new_events: number;
    escalations: number;
    error?: string;
  }
  const outcomes: RowOutcome[] = [];
  let totalEscalations = 0;
  let totalNewThreadLinks = 0;

  for (const l of cohort) {
    const email = (l.agentEmail ?? "").trim();
    const linkedIds = parseThreadIds(l.gmailThreadIds);
    try {
      // (a) agent-email query + (b) every linked thread, deduped by msg id.
      const byId = new Map<string, GmailMessage>();
      if (email) {
        for (const m of await getThreadsForEmail(email, sinceMinutes)) byId.set(m.id, m);
      }
      for (const tid of linkedIds) {
        for (const m of await getThreadById(tid)) if (!byId.has(m.id)) byId.set(m.id, m);
      }
      // Linked-thread fetches return whole threads — bound to the sweep window.
      const msgs = [...byId.values()].filter((m) => {
        const t = m.date ? new Date(m.date).getTime() : NaN;
        return !Number.isFinite(t) || t >= sinceMs;
      });

      const r = appendGmailMessagesToNotes(
        l.notes,
        msgs.map((m) => ({ id: m.id, threadId: m.threadId, from: m.from, body: m.body, date: m.date })),
        ourAddress,
        { syncMarkerSource: "gmail_sync" },
      );

      const fields: Record<string, unknown> = {};
      if (r.newEvents.length > 0) {
        fields["Verification_Notes"] = r.notes;
        // Stamp Last_Inbound_At forward only (email replies count like SMS).
        const newest = newestInboundIso(r.newEvents);
        if (newest && (!l.lastInboundAt || new Date(newest) > new Date(l.lastInboundAt))) {
          fields["Last_Inbound_At"] = newest;
        }
      }
      // Persist newly-seen deal threads — ingested messages only (a thread we
      // wrote into the record is a deal thread by definition).
      const mergedLinks = mergeThreadIds(
        l.gmailThreadIds,
        r.newEvents.map((e) => e.threadId ?? "").filter(Boolean),
      );
      if (mergedLinks != null) {
        fields["Gmail_Thread_Ids"] = mergedLinks;
        totalNewThreadLinks++;
      }
      // ── RECOMMENDED REPLIES (2026-07-12): the newest ingested inbound
      // generates a guardrailed 2A draft (forge, email register) — queued as
      // a jarvis_reply proposal with a send_email payload and mirrored onto
      // the listing for the Live Deals strip. Idempotent by inbound msg id.
      // Shared with quo-sync via lib/inbound/reply-draft-trigger so the SMS +
      // email drafting can't drift (P2.1, 2026-07-13).
      if (r.newEvents.length > 0) {
        try {
          const newestEvent = [...r.newEvents].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
          const srcMsg = msgs.find((m) => m.id === newestEvent.id);
          if (srcMsg) {
            const draft = await buildInboundReplyDraft({
              listing: {
                id: l.id,
                address: l.address,
                outreachStatus: l.outreachStatus,
                underwrittenMao: l.underwrittenMao ?? null,
                mao: l.mao ?? null,
                listPrice: l.listPrice ?? null,
                agentName: l.agentName ?? null,
                agentEmail: email || null,
                draftReplyMeta: l.draftReplyMeta ?? null,
                ddVolleyState: l.ddVolleyState ?? null,
              },
              notes: r.notes,
              inbound: { msgId: newestEvent.id, body: srcMsg.body, from: srcMsg.from, subject: srcMsg.subject },
              channel: "email",
            });
            if (draft.proposal) {
              const created = await createReplyProposal(draft.proposal);
              fields["Draft_Reply_Text"] = draft.draftText;
              fields["Draft_Reply_Meta"] = JSON.stringify({
                ...draft.draftMeta,
                proposal_id: created ? draft.proposal.proposalId : undefined,
              });
            }
            // B2 DD-volley: persist updated state + stamp any DD answer to notes.
            if (draft.extraFields) Object.assign(fields, draft.extraFields);
            if (draft.notesAppend) {
              fields["Verification_Notes"] = `${fields["Verification_Notes"] ?? r.notes}\n\n${draft.notesAppend}`;
            }
          }
        } catch (err) {
          console.error("[gmail_sync] reply draft failed:", err);
        }
      }
      if (Object.keys(fields).length > 0) {
        await updateListingRecord(l.id, fields);
      }
      if (r.newEvents.length > 0 && r.escalationCount > 0) {
        await audit({
          agent: "outreach",
          event: "gmail_sync_escalation",
          status: "confirmed_success",
          recordId: l.id,
          inputSummary: { address: l.address, agent_email: email || null, hours_back: hoursBack },
          outputSummary: { new_events: r.newEvents.length, escalations: r.escalationCount, amounts: r.newEvents.flatMap((e) => e.amounts.map((a) => a.amountUsd)) },
          decision: "escalate",
        });
      }
      outcomes.push({ recordId: l.id, address: l.address, agent_email: email || null, linked_threads: linkedIds.length, new_events: r.newEvents.length, escalations: r.escalationCount });
      totalEscalations += r.escalationCount;
    } catch (err) {
      outcomes.push({ recordId: l.id, address: l.address, agent_email: email || null, linked_threads: linkedIds.length, new_events: 0, escalations: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const summary = {
    population_syncable: selection.populationSyncable,
    live_money_always_synced: selection.liveMoneyCount,
    cohort_size: cohort.length,
    truncated_this_run: selection.truncated,
    rotation_window: selection.rotationWindow,
    rows_with_new_events: outcomes.filter((r) => r.new_events > 0).length,
    new_thread_links: totalNewThreadLinks,
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
