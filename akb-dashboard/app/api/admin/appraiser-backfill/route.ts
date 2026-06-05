// Phase 16.x / M — Appraiser backfill.
//
// GET /api/admin/appraiser-backfill[?apply=1&limit=N&include_manual_review=1&force=1]
//
// One-shot admin tool that exercises the Appraiser endpoints (ARV →
// Rehab → Buyer Intelligence) across the active pipeline so the new
// BroCard v1.3 pricing reflects on every active record, not just
// future ones. ~37 active deals have zero ARV / rehab / rent data per
// the 5/18 session-open briefing; Phase 4 is built but invisible until
// exercised.
//
// **M.1 shipped dry-run + audit.** **M.2 layers on apply mode +
// idempotency + rate-limit pacing** — Alex's explicit atomic boundary
// so apply behavior never exists without its safety rails.
//
// **Auth posture:** No app-level auth on this route. Follows the same
// convention as every other /api/admin/* endpoint in this codebase
// (d3-backfill-offer-fields, bulk-dead-stale-texted, etc.) — access
// control lives at the Vercel deployment layer (branch preview alias
// is private to Alex's team).
//
// **Lambda budget:** maxDuration = 300 (Hobby ceiling). Apply mode
// processes records serially with per-endpoint waits (ARV ~10s, Rehab
// ~20s, BuyerIntel ~10s) + pace_ms between records. Realistic
// throughput: ~6-10 records per invocation at default 2000ms pacing.
// Operator iterates with ?limit=N + re-runs until coverage is
// complete. The loop checks elapsed-vs-budget and stops cleanly so
// the final audit always lands.

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, getRehabSweepCandidates } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  aggregateBackfillStatus,
  classifyBackfillEligibility,
  estimateBackfillCost,
  readBackfillPaceMs,
  totalBackfillCost,
  type BackfillCostEstimate,
  type BackfillEligibility,
  type BackfillEndpointOutcome,
  type BackfillRecordApplyOutcome,
} from "@/lib/admin/appraiser-backfill";

function originFromReq(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

// Budget guard: stop the loop when remaining time wouldn't fit a full
// record (worst-case ~70s per record + pace). Leaves ~10s for the
// final audit + JSON response. Picked conservatively — better to
// return a partial result than to have the lambda 504 mid-write.
const MAX_RECORD_BUDGET_MS = 70_000;
const SAFETY_BUFFER_MS = 10_000;

async function callEndpoint(
  origin: string,
  path: string,
  cookie: string | null,
  authorization: string | null = null,
  xVercelCron: string | null = null,
): Promise<BackfillEndpointOutcome> {
  const t = Date.now();
  try {
    const headers: Record<string, string> = {};
    // Forward dashboard cookie (original operator-driven path) AND any
    // bearer Authorization + x-vercel-cron header the caller arrived
    // with. The agent endpoints share the same auth waterfall as this
    // route, so a CRON_SECRET fire (Vercel cron) flows through to the
    // sub-requests cleanly. Spine rec6e6hYLuOpaLANf reconciliation —
    // 2026-06-04: before this, CRON_SECRET callers got 401 from every
    // sub-request because only the cookie was forwarded.
    if (cookie) headers.cookie = cookie;
    if (authorization) headers.authorization = authorization;
    if (xVercelCron) headers["x-vercel-cron"] = xVercelCron;
    const res = await fetch(`${origin}${path}`, { headers, cache: "no-store" });
    const elapsed = Date.now() - t;
    if (!res.ok) {
      // Best-effort error message — read body but don't fail on parse.
      const body = await res.text().catch(() => "");
      return {
        status: "error",
        http_status: res.status,
        elapsed_ms: elapsed,
        error: body ? body.slice(0, 500) : `HTTP ${res.status}`,
      };
    }
    return { status: "ok", http_status: res.status, elapsed_ms: elapsed, error: null };
  } catch (err) {
    return {
      status: "error",
      http_status: null,
      elapsed_ms: Date.now() - t,
      error: String(err).slice(0, 500),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const runtime = "nodejs";
// 300s ceiling per Vercel Hobby plan. M.1 is dry-run only (no
// per-record API calls) so this is conservative — actual elapsed for
// 37 records is well under a second. M.2 apply mode will exercise
// the full budget when ~3-4 records per request can fit.
export const maxDuration = 300;

interface BackfillRecordOutcome {
  record: BackfillEligibility;
  cost: BackfillCostEstimate;
  address: string;
  state: string | null;
  outreach_status: string | null;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit =
    limitParam != null ? Math.max(1, parseInt(limitParam, 10) || 0) : null;
  const includeManualReview =
    url.searchParams.get("include_manual_review") === "1";
  const force = url.searchParams.get("force") === "1";
  const apply = url.searchParams.get("apply") === "1";
  const paceMs = readBackfillPaceMs();

  // Skip + cursor support (2026-06-04): before this, `slice(0, limit)`
  // always took the SAME first N records, so a record with a structural
  // blocker (missing Building_SqFt → rehab 422) made a small-limit cron
  // recycle it forever without ever reaching the rest of the cluster.
  //   ?skip=recA,recB   — exclude these record ids outright.
  //   ?after=recX       — only process records whose id sorts AFTER recX
  //                       (a lexical cursor; pair with ?limit to page).
  // Sorting by id first makes `after` a deterministic cursor.
  const skipIds = new Set(
    (url.searchParams.get("skip") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("rec")),
  );
  const after = url.searchParams.get("after");

  // ── Selection mode (2026-06-05) ─────────────────────────────────
  //   default          — briefing-active set (Outreach_Status-based;
  //                       Negotiating/Response Received/Counter
  //                       Received/Offer Accepted + recent Texted/
  //                       Emailed). Kept for the ARV/rent sweeps.
  //   ?selection=rehab_ready
  //                    — records that can ACTUALLY produce a vision
  //                       rehab: Live_Status=Active AND a non-empty
  //                       Verification_URL. This stops the sweep from
  //                       crawling lex-first into the ~396 URL-less
  //                       actives (Firecrawl can't fire on them →
  //                       Street-View-only → rehab preflight refusal).
  //                       Expect ~1,751 candidates.
  const selection = url.searchParams.get("selection");
  const rehabReady = selection === "rehab_ready";
  const active = rehabReady
    ? await getRehabSweepCandidates()
    : await getActiveListingsForBrief({ recentDays: 7 });
  const ordered = [...active].sort((a, b) => a.id.localeCompare(b.id));
  const filtered = ordered.filter(
    (l) => !skipIds.has(l.id) && (after ? l.id.localeCompare(after) > 0 : true),
  );
  const subset = limit != null ? filtered.slice(0, limit) : filtered;

  const outcomes: BackfillRecordOutcome[] = subset.map((l) => {
    const eligibility = classifyBackfillEligibility(l, {
      includeManualReview,
      force,
    });
    const cost = estimateBackfillCost(l);
    return {
      record: eligibility,
      cost,
      address: l.address,
      state: l.state,
      outreach_status: l.outreachStatus,
    };
  });

  const eligible = outcomes.filter((o) => o.record.eligible);
  const skipped = outcomes.filter((o) => !o.record.eligible);

  const skip_breakdown = {
    manual_review_low_arv: skipped.filter(
      (o) => o.record.skipReason === "manual_review_low_arv",
    ).length,
    already_complete: skipped.filter(
      (o) => o.record.skipReason === "already_complete",
    ).length,
    missing_zip: skipped.filter(
      (o) => o.record.skipReason === "missing_zip",
    ).length,
  };

  const totalCost = totalBackfillCost(eligible.map((o) => o.cost));

  // Cursor for the next page: the highest record id we examined this
  // call. A cron/operator passes ?after=<next_cursor> to advance past
  // the records already processed — so a structurally-blocked record
  // can't trap the sweep on subsequent fires.
  const next_cursor = subset.length > 0 ? subset[subset.length - 1].id : null;

  if (!apply) {
    await audit({
      agent: "appraiser",
      event: "backfill_dry_run",
      status: "confirmed_success",
      inputSummary: {
        limit,
        include_manual_review: includeManualReview,
        force,
        selection: rehabReady ? "rehab_ready" : "brief_active",
        active_total: active.length,
        examined: subset.length,
      },
      outputSummary: {
        eligible_count: eligible.length,
        skipped_count: skipped.length,
        skip_breakdown,
        cost_estimate: totalCost,
        pace_ms_configured: paceMs,
      },
      decision: "dry_run",
      ms: Date.now() - t0,
    });

    return NextResponse.json({
      mode: "dry_run",
      apply_available: true,
      selection: rehabReady ? "rehab_ready" : "brief_active",
      pace_ms: paceMs,
      elapsed_ms: Date.now() - t0,
      active_total_in_airtable: active.length,
      candidate_count: active.length,
      examined: subset.length,
      next_cursor,
      summary: {
        eligible: eligible.length,
        skipped: skipped.length,
        skip_breakdown,
        cost_estimate: totalCost,
      },
      eligible_sample: eligible.slice(0, 100).map((o) => ({
        recordId: o.record.recordId,
        address: o.address,
        state: o.state,
        outreach_status: o.outreach_status,
        current: o.record.current,
        cost: o.cost,
      })),
      skipped_sample: skipped.slice(0, 100).map((o) => ({
        recordId: o.record.recordId,
        address: o.address,
        outreach_status: o.outreach_status,
        skip_reason: o.record.skipReason,
        current: o.record.current,
      })),
    });
  }

  // ── Apply mode ─────────────────────────────────────────────────────────
  const origin = originFromReq(req);
  const cookie = req.headers.get("cookie");
  // Forward the incoming bearer + x-vercel-cron so a CRON_SECRET fire
  // can drive this end-to-end without a dashboard cookie. (2026-06-04)
  const authorization = req.headers.get("authorization");
  const xVercelCron = req.headers.get("x-vercel-cron");

  const applied: BackfillRecordApplyOutcome[] = [];
  let truncated_by_budget = false;

  for (let i = 0; i < eligible.length; i++) {
    const o = eligible[i];
    const elapsed = Date.now() - t0;
    const remaining = maxDuration * 1000 - elapsed;
    // Stop cleanly if we wouldn't have enough room for another full
    // record + the trailing audit write. Better to return partial
    // results than to have Vercel kill us mid-write.
    if (remaining < MAX_RECORD_BUDGET_MS + SAFETY_BUFFER_MS) {
      truncated_by_budget = true;
      break;
    }

    const recordT0 = Date.now();
    const arv = await callEndpoint(
      origin,
      `/api/agents/appraiser/arv/${o.record.recordId}`,
      cookie,
      authorization,
      xVercelCron,
    );
    const rehab = await callEndpoint(
      origin,
      `/api/agents/appraiser/rehab/${o.record.recordId}`,
      cookie,
      authorization,
      xVercelCron,
    );
    const buyerIntel = await callEndpoint(
      origin,
      `/api/agents/appraiser/buyer-intelligence/${o.record.recordId}`,
      cookie,
      authorization,
      xVercelCron,
    );

    const aggregate = aggregateBackfillStatus(arv.status, rehab.status, buyerIntel.status);

    const outcome: BackfillRecordApplyOutcome = {
      recordId: o.record.recordId,
      status: aggregate,
      arv,
      rehab,
      buyer_intelligence: buyerIntel,
      total_elapsed_ms: Date.now() - recordT0,
    };
    applied.push(outcome);

    // Per-record audit so Maverick load-state can surface backfill
    // progress in real time + downstream Pulse can baseline endpoint
    // failure rates across the active pipeline.
    await audit({
      agent: "appraiser",
      event: "backfill_record_applied",
      status: aggregate === "ok" ? "confirmed_success" : "confirmed_failure",
      recordId: o.record.recordId,
      inputSummary: {
        address: o.address,
        state: o.state,
        outreach_status: o.outreach_status,
      },
      outputSummary: {
        aggregate_status: aggregate,
        arv: { status: arv.status, http: arv.http_status, ms: arv.elapsed_ms, error: arv.error },
        rehab: { status: rehab.status, http: rehab.http_status, ms: rehab.elapsed_ms, error: rehab.error },
        buyer_intelligence: {
          status: buyerIntel.status,
          http: buyerIntel.http_status,
          ms: buyerIntel.elapsed_ms,
          error: buyerIntel.error,
        },
      },
      decision: aggregate,
      ms: outcome.total_elapsed_ms,
    });

    // Pace between records. Skip the wait on the last iteration —
    // there's no next record to pace against.
    if (paceMs > 0 && i < eligible.length - 1) {
      await sleep(paceMs);
    }
  }

  const apply_summary = {
    total: applied.length,
    ok: applied.filter((a) => a.status === "ok").length,
    partial: applied.filter((a) => a.status === "partial").length,
    error: applied.filter((a) => a.status === "error").length,
    truncated_by_budget,
    remaining_eligible: eligible.length - applied.length,
  };

  await audit({
    agent: "appraiser",
    event: "backfill_apply_run",
    status: apply_summary.error === applied.length && applied.length > 0
      ? "confirmed_failure"
      : "confirmed_success",
    inputSummary: {
      limit,
      include_manual_review: includeManualReview,
      force,
      pace_ms: paceMs,
      eligible_total: eligible.length,
    },
    outputSummary: {
      ...apply_summary,
      cost_estimate: totalCost,
    },
    decision: truncated_by_budget ? "applied_truncated_by_budget" : "applied",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: "apply",
    apply_available: true,
    pace_ms: paceMs,
    elapsed_ms: Date.now() - t0,
    active_total_in_airtable: active.length,
    examined: subset.length,
    next_cursor,
    summary: {
      eligible: eligible.length,
      skipped: skipped.length,
      skip_breakdown,
      cost_estimate: totalCost,
      apply: apply_summary,
    },
    applied,
    skipped_sample: skipped.slice(0, 100).map((o) => ({
      recordId: o.record.recordId,
      address: o.address,
      outreach_status: o.outreach_status,
      skip_reason: o.record.skipReason,
      current: o.record.current,
    })),
  });
}
