// Controlled first-batch outreach — send to N selected leads, CONFIRM each
// send via OpenPhone message-status (not feed-walk), and let the existing
// reply-triage cron route the replies.
// @agent: crier
//
// GET|POST /api/admin/outreach-batch
//   default            DRY-RUN: select + plan, send nothing. Returns the
//                      exact batch that WOULD fire.
//   ?apply=1&confirm=FIRE-OUTREACH-BATCH-YYYY-MM-DD
//                      LIVE send — BUT also requires H2_OUTREACH_LIVE="true"
//                      (the same master kill switch the H2 cron honors). All
//                      three must hold or it stays dry.
//   ?limit=N           cap leads this batch (default 3, max 25). Deliberately
//                      tiny — this is the controlled first batch.
//   ?record_ids=rec,…  target specific leads (still eligibility-checked).
//   ?poll_attempts=N   status polls per send (default 6).
//   ?poll_delay_ms=N   spacing between status polls (default 5000).
//
// SEND-THEN-CONFIRM (operator 2026-06-08): a 2xx from the send API is NOT
// delivery (it returns status "queued"). This route polls
// getMessageStatus(id) until a TERMINAL state — delivered/sent (success) or
// failed/undelivered (failure) — and only marks Outreach_Status=Texted on a
// confirmed success. A send that never reaches terminal in the poll window
// is recorded "unconfirmed" and NOT marked Texted, so it isn't treated as a
// landed contact (closes the Quo silent-delivery gap, INV-019).
//
// Idempotency: a per-record KV dispatch claim (h2:dispatch:<id>, shared with
// the H2 cron) acquired BEFORE the Quo call — no record double-texts across
// this route + the cron. Eligibility reuses the H2 selector verbatim.
//
// Reply routing: a confirmed send sets Outreach_Status=Texted, which the
// scan-comms reply-triage cron already scans (now self-echo/bot filtered) —
// replies to this batch flow into the existing triage queue. No separate
// router needed.

import { NextResponse } from "next/server";
import { getListings, getListing, updateListingRecord } from "@/lib/airtable";
import { sendMessageWithId, getMessageStatus } from "@/lib/quo";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  selectH2Eligible,
  buildPriorContactIndex,
  planQueue,
  buildSentNote,
  ineligibleReasonForListing,
} from "@/lib/h2-outreach";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 25;
const DEFAULT_POLL_ATTEMPTS = 6;
const DEFAULT_POLL_DELAY_MS = 5_000;
const WALL_CLOCK_BUDGET_MS = 270_000;
const DISPATCH_CLAIM_TTL_S = 86_400;
const dispatchClaimKey = (recordId: string) => `h2:dispatch:${recordId}`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function todayToken(now = new Date()): string {
  return `FIRE-OUTREACH-BATCH-${now.toISOString().slice(0, 10)}`;
}

interface BatchRow {
  recordId: string;
  address: string;
  agentName: string | null;
  toE164: string | null;
  message: string | null;
  sent: boolean;
  quo_message_id: string | null;
  send_status: string | null;
  confirmed_status: string | null;
  delivered: boolean;
  confirmed: boolean;
  marked_texted: boolean;
  error: string | null;
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request): Promise<Response> {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth ──────────────────────────────────────────────────────────
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

  // ── Three-brake gate (mirrors the H2 cron) ────────────────────────
  const applyRequested = url.searchParams.get("apply") === "1";
  const confirm = url.searchParams.get("confirm");
  const envLive = process.env.H2_OUTREACH_LIVE === "true";
  // LIVE only when ALL of: apply=1, today's confirm token, env switch on.
  const live = applyRequested && confirm === todayToken() && envLive;
  const gateBlockedReason =
    !applyRequested ? "dry_run_default"
    : confirm !== todayToken() ? "confirm_token_missing_or_stale"
    : !envLive ? "H2_OUTREACH_LIVE_not_true"
    : null;

  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Math.min(MAX_LIMIT, Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT);
  const pollAttemptsRaw = Number(url.searchParams.get("poll_attempts"));
  const pollAttempts = Number.isFinite(pollAttemptsRaw) && pollAttemptsRaw > 0 ? Math.floor(pollAttemptsRaw) : DEFAULT_POLL_ATTEMPTS;
  const pollDelayRaw = Number(url.searchParams.get("poll_delay_ms"));
  const pollDelayMs = Number.isFinite(pollDelayRaw) && pollDelayRaw >= 0 ? Math.floor(pollDelayRaw) : DEFAULT_POLL_DELAY_MS;
  const recordIdsParam = url.searchParams.get("record_ids");
  const explicitIds = recordIdsParam ? recordIdsParam.split(",").map((s) => s.trim()).filter(Boolean) : [];

  // ── Select leads ──────────────────────────────────────────────────
  let leads: Listing[];
  const ineligible: Array<{ recordId: string; reason: string }> = [];
  try {
    if (explicitIds.length > 0) {
      const fetched = await Promise.all(explicitIds.map((id) => getListing(id).catch(() => null)));
      leads = [];
      for (let i = 0; i < explicitIds.length; i++) {
        const l = fetched[i];
        if (!l) { ineligible.push({ recordId: explicitIds[i], reason: "not_found" }); continue; }
        const reason = ineligibleReasonForListing(l);
        if (reason) { ineligible.push({ recordId: l.id, reason }); continue; }
        leads.push(l);
      }
    } else {
      const all = await getListings();
      leads = selectH2Eligible(all);
    }
  } catch (err) {
    return NextResponse.json({ error: "select_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Plan (message + route) and keep only the sendable first-touch leads, capped.
  const priorIndex = buildPriorContactIndex(await getListings().catch(() => []));
  const plans = planQueue(leads, priorIndex)
    .filter((p) => p.route === "first_touch" && p.toE164 && p.message)
    .slice(0, limit);

  // ── DRY-RUN short-circuit ─────────────────────────────────────────
  if (!live) {
    await audit({
      agent: "crier",
      event: "outreach_batch_dry_run",
      status: "confirmed_success",
      inputSummary: { auth_kind: authKind, limit, gate_blocked: gateBlockedReason },
      outputSummary: { planned: plans.length, ineligible: ineligible.length },
      ms: Date.now() - t0,
    });
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      gate_blocked: gateBlockedReason,
      detail:
        "No SMS fired. To send: ?apply=1&confirm=" + todayToken() +
        " AND H2_OUTREACH_LIVE=\"true\" in env. All three are required.",
      planned_count: plans.length,
      planned: plans.map((p) => ({ recordId: p.recordId, address: p.address, agentName: p.agentName, toE164: p.toE164, message: p.message })),
      ineligible,
      auth_kind: authKind,
      duration_ms: Date.now() - t0,
    });
  }

  // ── LIVE send + per-message confirm ───────────────────────────────
  const rows: BatchRow[] = [];
  for (const p of plans) {
    if (Date.now() - t0 > WALL_CLOCK_BUDGET_MS) break;
    const row: BatchRow = {
      recordId: p.recordId, address: p.address, agentName: p.agentName,
      toE164: p.toE164, message: p.message,
      sent: false, quo_message_id: null, send_status: null, confirmed_status: null,
      delivered: false, confirmed: false, marked_texted: false, error: null,
    };

    // Per-record dispatch claim — atomic, shared with the H2 cron.
    let claimed = false;
    try {
      claimed = await kvProd.setNx(dispatchClaimKey(p.recordId), new Date().toISOString(), DISPATCH_CLAIM_TTL_S);
    } catch {
      claimed = true; // KV down → don't block the controlled batch; idempotency falls back to the Outreach_Status gate
    }
    if (!claimed) {
      row.error = "dispatch_claim_held (already texted/claimed elsewhere)";
      rows.push(row);
      continue;
    }

    try {
      // 1) SEND
      const send = await sendMessageWithId(p.toE164!, p.message!);
      row.sent = true;
      row.quo_message_id = send.id;
      row.send_status = send.status;

      // 2) CONFIRM via message-status polling (NOT feed-walk).
      if (send.id) {
        for (let attempt = 0; attempt < pollAttempts; attempt++) {
          await sleep(pollDelayMs);
          try {
            const st = await getMessageStatus(send.id);
            row.confirmed_status = st.status;
            if (st.isTerminal) {
              row.confirmed = true;
              row.delivered = st.isSuccess;
              break;
            }
          } catch (err) {
            row.error = `status_poll: ${String(err).slice(0, 120)}`;
          }
        }
      } else {
        row.error = "send returned no message id — cannot confirm";
      }

      // 3) WRITE — only mark Texted on a CONFIRMED success (delivered/sent).
      //    Unconfirmed or failed → NOT marked Texted (no false landed-contact).
      const iso = new Date().toISOString();
      if (row.delivered) {
        const existing = (await getListing(p.recordId).catch(() => null))?.notes ?? null;
        await updateListingRecord(p.recordId, {
          Outreach_Status: "Texted",
          Last_Outbound_At: iso,
          Verification_Notes: buildSentNote(existing, iso, send.id, p.message!),
        });
        row.marked_texted = true;
      }

      await audit({
        agent: "crier",
        event: "outreach_batch_send",
        status: row.delivered ? "confirmed_success" : row.confirmed ? "confirmed_failure" : "uncertain",
        recordId: p.recordId,
        externalId: send.id ?? undefined,
        inputSummary: { to: p.toE164, address: p.address },
        outputSummary: { send_status: send.status, confirmed_status: row.confirmed_status, delivered: row.delivered, marked_texted: row.marked_texted },
        decision: row.delivered ? "delivered" : row.confirmed ? "delivery_failed" : "unconfirmed",
      });
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
      // Release the claim so a confirmed-failure send can be retried later.
      try { await kvProd.del(dispatchClaimKey(p.recordId)); } catch { /* best effort */ }
      await audit({
        agent: "crier",
        event: "outreach_batch_send",
        status: "confirmed_failure",
        recordId: p.recordId,
        inputSummary: { to: p.toE164, address: p.address },
        error: row.error,
      });
    }
    rows.push(row);
  }

  const delivered = rows.filter((r) => r.delivered).length;
  const sentUnconfirmed = rows.filter((r) => r.sent && !r.confirmed).length;
  const failed = rows.filter((r) => r.confirmed && !r.delivered).length;

  return NextResponse.json({
    ok: true,
    mode: "live",
    summary: {
      attempted: rows.length,
      delivered,
      delivery_failed: failed,
      sent_unconfirmed: sentUnconfirmed,
      marked_texted: rows.filter((r) => r.marked_texted).length,
    },
    rows,
    reply_routing: "Confirmed sends are Outreach_Status=Texted → the scan-comms reply-triage cron (self-echo/bot filtered) routes replies into the triage queue.",
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
  });
}
