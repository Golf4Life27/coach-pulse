// Phase 16.x / M.1 — Appraiser backfill (dry-run + audit).
//
// GET /api/admin/appraiser-backfill[?limit=N&include_manual_review=1]
//
// One-shot admin tool that exercises the Appraiser endpoints (ARV →
// Rehab → Buyer Intelligence) across the active pipeline so the new
// BroCard v1.3 pricing reflects on every active record, not just
// future ones. Right now ~37 active deals have zero ARV / rehab / rent
// data (per the 5/18 session-open briefing); Phase 4 is built but
// invisible until exercised.
//
// **M.1 ships dry-run + audit only.** Apply mode lands in M.2 alongside
// idempotency-on-write + rate-limit pacing — Alex's explicit atomic
// boundary so apply behavior never exists without its safety controls.
//
// **Auth posture:** No app-level auth on this route. Follows the same
// convention as every other /api/admin/* endpoint in this codebase
// (d3-backfill-offer-fields, bulk-dead-stale-texted, etc.) — access
// control lives at the Vercel deployment layer (branch preview alias
// is private to Alex's team). If app-level auth lands later it should
// be applied uniformly across admin/* routes, not bolted onto this one.
//
// **Audit stream integration:** Each dry-run writes a single
// `agent=appraiser, event=backfill_dry_run` entry so Maverick's
// load-state surface can show backfill activity. Apply mode (M.2)
// will add per-record audit events.

import { NextResponse } from "next/server";
import { getActiveListingsForBrief } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  classifyBackfillEligibility,
  estimateBackfillCost,
  totalBackfillCost,
  type BackfillCostEstimate,
  type BackfillEligibility,
} from "@/lib/admin/appraiser-backfill";

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

  // Recent days fetcher matches the briefing aggregator's view of the
  // pipeline (last 7 days of Texted/Emailed + everything in
  // Negotiating/Response Received/Counter Received/Offer Accepted).
  const active = await getActiveListingsForBrief({ recentDays: 7 });
  const subset = limit != null ? active.slice(0, limit) : active;

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

  await audit({
    agent: "appraiser",
    event: "backfill_dry_run",
    status: "confirmed_success",
    inputSummary: {
      limit,
      include_manual_review: includeManualReview,
      force,
      active_total: active.length,
      examined: subset.length,
    },
    outputSummary: {
      eligible_count: eligible.length,
      skipped_count: skipped.length,
      skip_breakdown,
      cost_estimate: totalCost,
    },
    decision: "dry_run_only",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: "dry_run",
    apply_available: false,
    apply_blocked_reason: "M.1 ships dry-run only. Apply mode lands in M.2 with rate-limit + idempotency-on-write safety controls.",
    elapsed_ms: Date.now() - t0,
    active_total_in_airtable: active.length,
    examined: subset.length,
    summary: {
      eligible: eligible.length,
      skipped: skipped.length,
      skip_breakdown,
      cost_estimate: totalCost,
    },
    // Cap at 100 — most callers want the summary. M.2 apply mode will
    // need the full outcome list per record, but for M.1 dry-run a
    // sample is fine.
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
