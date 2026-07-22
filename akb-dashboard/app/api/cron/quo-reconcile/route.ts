// Quo timestamp reconciliation poll (operator 2026-06-10).
// @agent: crier
//
// THE GAP it closes: scan-comms creates jarvis_reply proposals + (now)
// fires alerts, but Last_Inbound_At / Last_Outbound_At on Listings_V1
// are stamped only when a proposal create lands. Today's 13235 Freeland
// reply came in, was captured in Notes, and Outreach_Status flipped to
// Response Received — but Last_Inbound_At stayed null because scan-comms
// hadn't run yet. This poll fixes that by treating Quo as the source of
// truth for both timestamps and reconciling against the listings table
// every 10 minutes.
//
// Design — per the standing 'positive confirmation' rule, never overwrite
// a stamped timestamp with a stale value:
//   1. Pull active listings (the cohort we care about) and dedupe by
//      normalized agent phone.
//   2. For each phone, fetch the Quo thread for the lookback window.
//   3. Per-listing: the MOST RECENT incoming → candidate Last_Inbound_At;
//      the MOST RECENT outgoing → candidate Last_Outbound_At. Self-echo
//      / autoreply inbounds are stripped (same rule scan-comms uses).
//   4. Compare to the listing's current value: only write when the
//      candidate is strictly NEWER. Idempotent.
//
// Frequency: */10 * * * * (vercel.json) — Pro plan. The 60-second reply
// today proved daily/hourly cadence is the wrong shape; 10-minute parity
// with scan-comms keeps the loop tight. Self-limiting wall-clock budget
// (LAMBDA_BUDGET_MS) below the 300s ceiling so a long phone list never
// times out.

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, updateListingRecord } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";
import { isSelfEchoOrAutoreply } from "@/lib/conversation-check";
import { toE164 } from "@/lib/phone";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { selectThreadListing } from "@/lib/conversation-thread";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const SCAN_WINDOW_MINUTES = Number(process.env.QUO_RECONCILE_LOOKBACK_MIN ?? "60");
const MAX_PHONES_PER_RUN = Number(process.env.QUO_RECONCILE_MAX_PHONES ?? "40");
const LAMBDA_BUDGET_MS = Number(process.env.QUO_RECONCILE_BUDGET_MS ?? "45000");

// Field IDs (mirrors lib/airtable.ts mapping):
const F_LAST_INBOUND = "fld3IhR1DXzcVuq6F";
const F_LAST_OUTBOUND = "fldaK4lR5UNvycg11";

interface PerListingUpdate {
  recordId: string;
  address: string | null;
  reason: "inbound_only" | "outbound_only" | "both" | null;
  newLastInboundAt: string | null;
  newLastOutboundAt: string | null;
  priorLastInboundAt: string | null;
  priorLastOutboundAt: string | null;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall ───────────────────────────────────────────────────
  const cookieHeader = req.headers.get("cookie");
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
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
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  // ── Build phone → listings map (the active cohort) ───────────────────
  let active: Listing[];
  try {
    active = await getActiveListingsForBrief();
  } catch (err) {
    return NextResponse.json({ error: "active_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  const ACTIONABLE = new Set([
    "Texted",
    "Response Received",
    "Counter Received",
    "Negotiating",
    "Offer Accepted",
  ]);

  const phoneToListings = new Map<string, Listing[]>();
  for (const l of active) {
    if (!l.agentPhone) continue;
    if (!ACTIONABLE.has(l.outreachStatus ?? "")) continue;
    const e164 = toE164(l.agentPhone);
    if (!e164) continue;
    const arr = phoneToListings.get(e164) ?? [];
    arr.push(l);
    phoneToListings.set(e164, arr);
  }
  const phones = [...phoneToListings.keys()].slice(0, MAX_PHONES_PER_RUN);

  // ── Per-phone Quo fetch + per-listing reconciliation ─────────────────
  const updates: PerListingUpdate[] = [];
  const fetchErrors: Array<{ phone: string; error: string }> = [];
  let phonesScanned = 0;
  let listingsConsidered = 0;

  for (const phone of phones) {
    if (Date.now() - t0 > LAMBDA_BUDGET_MS) break;
    phonesScanned++;
    let msgs;
    try {
      msgs = await getMessagesForParticipant(phone, SCAN_WINDOW_MINUTES);
    } catch (e) {
      fetchErrors.push({ phone, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) });
      continue;
    }

    // Strip self-echo / autoreply inbounds before they pollute the
    // Last_Inbound_At reconciliation (same rule as scan-comms).
    const genuineInbounds = msgs
      .filter((m) => m.direction === "incoming" && !isSelfEchoOrAutoreply(m.body))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const outbounds = msgs
      .filter((m) => m.direction === "outgoing")
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const mostRecentInboundAt = genuineInbounds[0]?.createdAt ?? null;
    const mostRecentOutboundAt = outbounds[0]?.createdAt ?? null;

    // THREAD ATTRIBUTION (operator 2026-07-22, sibling of the scan-comms
    // fan-out): a shared agent phone is ONE SMS thread. The phone's most-recent
    // inbound/outbound belongs to the ACTIVE thread — the deal we last texted —
    // not to every listing the agent reps. Stamping the phone's fresh inbound
    // onto all of them resurrected the wrong property as a false "Your move"
    // (Fielding lighting up from the Gilchrist thread). Reconcile the one thread
    // listing; the others keep their own (correctly older) timestamps.
    const threadListing = selectThreadListing(phoneToListings.get(phone) ?? []);
    for (const listing of threadListing ? [threadListing] : []) {
      listingsConsidered++;
      const priorIn = listing.lastInboundAt ?? null;
      const priorOut = listing.lastOutboundAt ?? null;

      const newerInbound =
        mostRecentInboundAt &&
        (!priorIn || Date.parse(mostRecentInboundAt) > Date.parse(priorIn));
      const newerOutbound =
        mostRecentOutboundAt &&
        (!priorOut || Date.parse(mostRecentOutboundAt) > Date.parse(priorOut));

      if (!newerInbound && !newerOutbound) continue;

      const fields: Record<string, unknown> = {};
      if (newerInbound) fields[F_LAST_INBOUND] = mostRecentInboundAt;
      if (newerOutbound) fields[F_LAST_OUTBOUND] = mostRecentOutboundAt;
      try {
        await updateListingRecord(listing.id, fields);
        updates.push({
          recordId: listing.id,
          address: listing.address ?? null,
          reason: newerInbound && newerOutbound ? "both" : newerInbound ? "inbound_only" : "outbound_only",
          newLastInboundAt: newerInbound ? mostRecentInboundAt : null,
          newLastOutboundAt: newerOutbound ? mostRecentOutboundAt : null,
          priorLastInboundAt: priorIn,
          priorLastOutboundAt: priorOut,
        });
      } catch (e) {
        fetchErrors.push({ phone, error: `update_failed ${listing.id}: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}` });
      }
    }
  }

  await audit({
    agent: "crier",
    event: "quo_reconcile",
    status: fetchErrors.length === 0 ? "confirmed_success" : "uncertain",
    inputSummary: {
      auth_kind: authKind,
      phones_in_pool: phoneToListings.size,
      phones_scanned: phonesScanned,
      lookback_min: SCAN_WINDOW_MINUTES,
    },
    outputSummary: {
      listings_considered: listingsConsidered,
      updates: updates.length,
      errors: fetchErrors.length,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    phones_in_pool: phoneToListings.size,
    phones_scanned: phonesScanned,
    listings_considered: listingsConsidered,
    updates,
    update_count: updates.length,
    errors: fetchErrors.length > 0 ? fetchErrors : undefined,
    duration_ms: Date.now() - t0,
  });
}
