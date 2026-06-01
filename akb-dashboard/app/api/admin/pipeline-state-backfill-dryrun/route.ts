// Pipeline_State — dry-run backfill report (READ-ONLY).
// @agent: maverick
//
// GET /api/admin/pipeline-state-backfill-dryrun?sample_limit=N
//
// Operator step 1 of the eventual Pipeline_State mass backfill (spec §7
// step 4): runs the pure `deriveStageFromLegacy` against every record in
// Listings_V1 and returns a structured report — proposed stage histogram,
// reason histogram, confidence breakdown, conflict count, and samples of
// proposed transitions + conflicts. NO WRITES. The apply step is a
// SEPARATE endpoint that does not yet exist by design — review this
// report first.
//
// Auth: same waterfall as the other admin routes (dashboard cookie /
// OAuth / CRON_SECRET / dev bearer). No write side effects mean lower
// risk, but the report still exposes the full pipeline shape, so auth.
//
// Pure aggregator lives in lib/pipeline-state/backfill-report.ts; the
// route is a thin wrapper for testability + so the aggregator can be
// reused by a future apply route without route duplication.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  buildBackfillReport,
  type BackfillReportListing,
} from "@/lib/pipeline-state/backfill-report";

export const runtime = "nodejs";
// Listings_V1 is ~3,644 records and getListings is cached; pure derivation
// after fetch is microseconds per record. 60s is plenty.
export const maxDuration = 60;

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall (+ dashboard cookie) ──────────────────────────
  const cookieHeader = req.headers.get("cookie");
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired =
      kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json(
          { error: "unauthorized", reason: auth.reason },
          { status: 401 },
        );
      }
      authKind = auth.kind;
    }
  }

  // ── Params ──────────────────────────────────────────────────────
  const url = new URL(req.url);
  const sampleLimitRaw = url.searchParams.get("sample_limit");
  const sampleLimit =
    sampleLimitRaw && /^\d+$/.test(sampleLimitRaw)
      ? Math.min(500, Math.max(1, parseInt(sampleLimitRaw, 10)))
      : undefined;

  // ── Compute ──────────────────────────────────────────────────────
  try {
    const listings = await getListings();
    const fetched_ms = Date.now() - t0;

    // Project to the derivation-relevant fields only — keeps the response
    // payload small + makes the input contract explicit.
    const projected: BackfillReportListing[] = listings.map((l) => ({
      id: l.id,
      address: l.address ?? null,
      pipelineStage: l.pipelineStage ?? null,
      outreachStatus: l.outreachStatus ?? null,
      executionPath: l.executionPath ?? null,
      liveStatus: l.liveStatus ?? null,
      envelopeId: l.envelopeId ?? null,
      contractOfferPrice: l.contractOfferPrice ?? null,
    }));

    const report = buildBackfillReport(projected, { sampleLimit });
    const total_ms = Date.now() - t0;

    await audit({
      agent: "maverick",
      event: "pipeline_state_backfill_dryrun",
      status: "confirmed_success",
      inputSummary: {
        auth_kind: authKind,
        sample_limit: sampleLimit ?? 50,
      },
      outputSummary: {
        total_records: report.total_records,
        records_already_populated: report.records_already_populated,
        records_with_proposed_change: report.records_with_proposed_change,
        records_with_conflicts: report.records_with_conflicts,
        confidence: report.confidence_breakdown,
        fetched_ms,
      },
      decision: "report_computed",
      ms: total_ms,
    });

    return NextResponse.json({
      ok: true,
      dry_run: true,
      apply_endpoint_exists: false,
      message:
        "READ-ONLY. No records were modified. The mass-backfill apply step is gated on operator review of this report — there is intentionally no apply endpoint yet.",
      fetched_ms,
      total_ms,
      report,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "maverick",
      event: "pipeline_state_backfill_dryrun",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind, sample_limit: sampleLimit ?? 50 },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { ok: false, error: "report_failed", message: msg },
      { status: 500 },
    );
  }
}
