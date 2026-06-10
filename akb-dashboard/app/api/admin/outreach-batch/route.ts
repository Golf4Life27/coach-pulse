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
  outreachReadyReason,
  buildPriorContactIndex,
  planQueue,
  buildSentNote,
} from "@/lib/h2-outreach";
import { evaluateSendWindow } from "@/lib/h2-working-hours";
import { openerMaoGuard, resolveOpenerCeiling } from "@/lib/outreach-economics";
import { loadUnderwriteContextForListings } from "@/lib/track-aware-underwrite";
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
  /** SAFETY GATE (item 0): true when the send was BLOCKED because the
   *  property's local time is outside the 8–20 TCPA send window. */
  blocked_quiet_hours: boolean;
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

  // ── Select leads + per-record disposition audit ──────────────────
  // After 2026-06-09 (the underwrite field-fix), silent absence is a defect
  // class: every input record must appear in exactly ONE bucket with a
  // reason. The dispositioning below covers the three silent-drop seams
  // (the global selectOutreachReady filter, the planQueue non-first_touch
  // routes, and a defensive first_touch-but-missing-phone-or-message check)
  // so the dry-run report is a complete funnel audit of in-scope leads.
  type Disposition =
    | "planned"
    | "planned_over_limit"
    | "ineligible"
    | "pre_outreach_filter"
    | "prior_contact_stalled"
    | "bad_phone_quarantined"
    | "route_skipped"
    | "incomplete_plan"
    | "out_of_zip_scope";
  interface RecordDisposition {
    recordId: string;
    address: string | null;
    zip: string | null;
    disposition: Disposition;
    reason: string | null;
    prior?: { recordId: string; address: string; status: string } | null;
  }
  const dispositions: RecordDisposition[] = [];
  const dispose = (l: { id: string; address?: string | null; zip?: string | null }, d: Disposition, reason: string | null, prior?: RecordDisposition["prior"]) => {
    dispositions.push({ recordId: l.id, address: l.address ?? null, zip: l.zip ?? null, disposition: d, reason, ...(prior != null ? { prior } : {}) });
  };

  // ── Step 1: fetch + scope ────────────────────────────────────────
  let allListings: Listing[] = [];
  let inputCohort: Listing[];
  const ineligible: Array<{ recordId: string; reason: string }> = [];
  try {
    if (explicitIds.length > 0) {
      const fetched = await Promise.all(explicitIds.map((id) => getListing(id).catch(() => null)));
      inputCohort = [];
      for (let i = 0; i < explicitIds.length; i++) {
        const l = fetched[i];
        if (!l) {
          ineligible.push({ recordId: explicitIds[i], reason: "not_found" });
          dispose({ id: explicitIds[i] }, "ineligible", "not_found");
          continue;
        }
        inputCohort.push(l);
      }
    } else {
      allListings = await getListings();
      inputCohort = allListings;
    }
  } catch (err) {
    return NextResponse.json({ error: "select_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Optional ZIP scope (?zips=48227,48228): hard-constrain the batch to a
  // market. Out-of-scope records get a disposition (NOT silent).
  const zipScope = new Set(
    (url.searchParams.get("zips") ?? "").split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z)),
  );
  let inScope: Listing[];
  if (zipScope.size > 0) {
    inScope = [];
    for (const l of inputCohort) {
      if (zipScope.has((l.zip ?? "").trim())) {
        inScope.push(l);
      } else {
        const reason = `out_of_zip_scope (${l.zip ?? "?"})`;
        ineligible.push({ recordId: l.id, reason });
        dispose(l, "out_of_zip_scope", reason);
      }
    }
  } else {
    inScope = inputCohort;
  }

  // ── Step 2: per-record outreach-ready evaluation (was a silent filter).
  // Every fail gets a reason here; pre_outreach_filter is its own bucket.
  const ready: Listing[] = [];
  for (const l of inScope) {
    const rr = outreachReadyReason(l);
    if (!rr.ready) {
      dispose(l, "pre_outreach_filter", rr.reason ?? "not_outreach_ready");
      continue;
    }
    ready.push(l);
  }

  // ── Step 3: opener-vs-MAO guard ──────────────────────────────────
  // Priceable markets only: the 65%-of-list door-opener (MAO_V1) must never
  // exceed the deal's underwritten MAO. The resolver reads Underwritten_MAO
  // from the listing first (primary path, no live I/O); the ZIP-store
  // context is a legitimate fallback for intake rows too fresh to have been
  // written. A missing MAO surfaces the DISTINCT mao_not_underwritten error
  // (not the old silent fallback to "needs ARV + rehab").
  const uwCtx = await loadUnderwriteContextForListings(ready);
  const guardedLeads: Listing[] = [];
  for (const l of ready) {
    const ceiling = resolveOpenerCeiling(l, uwCtx);
    const guard = openerMaoGuard({ baseOpener: l.mao, mao: ceiling.mao, priceable: ceiling.priceable });
    if (!guard.ok) {
      const reason = guard.reason ?? "opener_exceeds_mao";
      ineligible.push({ recordId: l.id, reason });
      dispose(l, "ineligible", reason);
      continue;
    }
    if (guard.capped && guard.opener != null) l.mao = guard.opener;
    guardedLeads.push(l);
  }
  let leads = guardedLeads;

  // ── Step 4: planQueue → bucket every route (was: silent filter to first_touch).
  const priorIndex = buildPriorContactIndex(allListings.length > 0 ? allListings : await getListings().catch(() => []));
  const allPlans = planQueue(leads, priorIndex);
  const firstTouchPlans = [] as typeof allPlans;
  for (const p of allPlans) {
    if (p.route === "prior_contact_stall") {
      dispose({ id: p.recordId, address: p.address, zip: null }, "prior_contact_stalled", p.prior ? `same agent already contacted at ${p.prior.address}` : "same agent already contacted", p.prior ?? null);
    } else if (p.route === "bad_phone_quarantine") {
      dispose({ id: p.recordId, address: p.address, zip: null }, "bad_phone_quarantined", "agent phone could not normalize to E.164");
    } else if (p.route === "skipped") {
      dispose({ id: p.recordId, address: p.address, zip: null }, "route_skipped", p.skipReason ?? "route_skipped");
    } else if (p.route === "first_touch") {
      if (!p.toE164 || !p.message) {
        dispose({ id: p.recordId, address: p.address, zip: null }, "incomplete_plan", `first_touch missing ${!p.toE164 ? "toE164 " : ""}${!p.message ? "message" : ""}`.trim());
      } else {
        firstTouchPlans.push(p);
      }
    }
  }
  const plans = firstTouchPlans.slice(0, limit);
  for (const p of plans) dispose({ id: p.recordId, address: p.address, zip: null }, "planned", null);
  for (const p of firstTouchPlans.slice(limit)) dispose({ id: p.recordId, address: p.address, zip: null }, "planned_over_limit", `dropped by limit=${limit}`);
  // Property state (for the quiet-hours timezone) — the plan carries city, not state.
  const stateById = new Map(leads.map((l) => [l.id, l.state]));

  // ── Funnel audit: every input lead must appear exactly once. ──────
  const seen = new Set(dispositions.map((d) => d.recordId));
  const inputIds = new Set([...inputCohort.map((l) => l.id), ...explicitIds]);
  const missing_from_funnel = [...inputIds].filter((id) => !seen.has(id));
  const bucket_counts: Record<Disposition, number> = {
    planned: 0, planned_over_limit: 0, ineligible: 0,
    pre_outreach_filter: 0, prior_contact_stalled: 0,
    bad_phone_quarantined: 0, route_skipped: 0,
    incomplete_plan: 0, out_of_zip_scope: 0,
  };
  for (const d of dispositions) bucket_counts[d.disposition]++;
  const funnel_audit = {
    input_count: inputIds.size,
    in_zip_scope: zipScope.size > 0 ? inScope.length : null,
    disposition_total: dispositions.length,
    missing_from_funnel,
    bucket_counts,
  };

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
      // Every drop seam now surfaces a bucket with a per-record reason — no
      // silent absence. Confirm input_count == disposition_total, and check
      // missing_from_funnel is []; if not, a NEW drop seam needs surfacing.
      funnel_audit,
      pre_outreach_filter: dispositions.filter((d) => d.disposition === "pre_outreach_filter"),
      prior_contact_stalled: dispositions.filter((d) => d.disposition === "prior_contact_stalled"),
      bad_phone_quarantined: dispositions.filter((d) => d.disposition === "bad_phone_quarantined"),
      route_skipped: dispositions.filter((d) => d.disposition === "route_skipped"),
      incomplete_plan: dispositions.filter((d) => d.disposition === "incomplete_plan"),
      planned_over_limit: dispositions.filter((d) => d.disposition === "planned_over_limit"),
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
      delivered: false, confirmed: false, marked_texted: false,
      blocked_quiet_hours: false, error: null,
    };

    // ── SAFETY GATE (item 0): hard quiet-hours floor, non-disableable.
    // No SMS fires outside 8–20 in the property's local timezone. This is
    // checked HERE (per-lead, just before the Quo call) so it can't be
    // bypassed by the route's gate flags. ──
    const wh = evaluateSendWindow(stateById.get(p.recordId) ?? null);
    if (!wh.inside) {
      row.blocked_quiet_hours = true;
      row.error = `outside_send_window (local_hour=${wh.meta.local_hour} tz=${wh.meta.timezone}, window ${wh.meta.window_start}-${wh.meta.window_end})`;
      rows.push(row);
      continue; // no claim, no send, no write
    }

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
        const fresh = await getListing(p.recordId).catch(() => null);
        const fields: Record<string, unknown> = {
          Outreach_Status: "Texted",
          Last_Outbound_At: iso,
          Verification_Notes: buildSentNote(fresh?.notes ?? null, iso, send.id, p.message!),
        };
        // STICKY CAPTURE (2026-06-10 smoke-test root cause): the batch never
        // wrote Outreach_Offer_Price, so downstream readers (Tier 1 alert
        // recommendations, D3 drift detection) found nulls on records that
        // demonstrably had a sent offer. Same contract outreach-fire honors:
        // sticky, set once at send, never recomputed.
        if (!(typeof fresh?.outreachOfferPrice === "number" && fresh.outreachOfferPrice > 0) && p.mao != null && p.mao > 0) {
          fields["Outreach_Offer_Price"] = p.mao; // the guarded opener that was actually sent
        }
        if (fresh?.listPrice != null && fresh.listPrice > 0 && fresh?.listPriceAtSend == null) {
          fields["List_Price_At_Send"] = fresh.listPrice;
        }
        await updateListingRecord(p.recordId, fields);
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
  const blockedQuietHours = rows.filter((r) => r.blocked_quiet_hours).length;

  return NextResponse.json({
    ok: true,
    mode: "live",
    summary: {
      attempted: rows.length,
      delivered,
      delivery_failed: failed,
      sent_unconfirmed: sentUnconfirmed,
      blocked_quiet_hours: blockedQuietHours,
      marked_texted: rows.filter((r) => r.marked_texted).length,
    },
    rows,
    reply_routing: "Confirmed sends are Outreach_Status=Texted → the scan-comms reply-triage cron (self-echo/bot filtered) routes replies into the triage queue.",
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
  });
}
