// D3 Phase 0b — Cheap math filter endpoint.
//
// GET /api/admin/d3-math-filter?limit=N&rentcast_available=N
//
// Scans Listings_V1 for Outreach_Status="Texted" records, classifies
// each into one of seven math buckets via lib/d3-math-filter.classifyMath().
// Pure read — no writes regardless of params. Phase 0b is REPORT-ONLY
// by design; cadence routing lands in Phase 0c/0d after Alex sees the
// bucket distribution.
//
// Per Alex 5/13 math-filter-first sequencing:
//   - Math fails (null_inputs / negative / below_threshold / list_drift)
//     exit pipeline WITHOUT burning RentCast quota.
//   - math_pass_needs_refresh is the candidate pool for Phase 0b.5
//     selective Pricing Agent re-run (quota-gated, ~146 calls budgeted).
//   - math_pass_auto + math_pass_manual proceed to Phase 0c market
//     re-verify.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { classifyMath, summarizeMath, type MathResult } from "@/lib/d3-math-filter";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 0) : null;
  // Default RentCast budget assumes ~150 reserved for live May pipeline,
  // leaving ~293 available for D3 backfill. Override via query if Alex
  // wants a tighter or looser budget.
  const rentcastParam = url.searchParams.get("rentcast_available");
  const rentcastAvailable = rentcastParam
    ? Math.max(0, parseInt(rentcastParam, 10) || 0)
    : 293;

  const allListings = await getListings();
  const texted = allListings.filter(
    (l) => (l.outreachStatus ?? "").toLowerCase() === "texted",
  );
  const subset = limit != null ? texted.slice(0, limit) : texted;

  const results: MathResult[] = subset.map((l) => classifyMath(l));
  const summary = summarizeMath(results, { rentcastCallsAvailable: rentcastAvailable });

  await audit({
    agent: "d3-math-filter",
    event: "math_filter_run",
    status: "confirmed_success",
    inputSummary: {
      limit,
      rentcast_available: rentcastAvailable,
      total_texted: texted.length,
      examined: subset.length,
    },
    outputSummary: {
      summary,
    },
    decision: "report_only",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: "report_only",
    elapsed_ms: Date.now() - t0,
    texted_total_in_airtable: texted.length,
    examined: subset.length,
    summary,
    // Per-record results capped at 200 to keep payload sane. Full set
    // lives in audit log.
    results_sample: results.slice(0, 200).map((r) => ({
      recordId: r.recordId,
      bucket: r.bucket,
      reasoning: r.reasoning,
      data_examined: r.data_examined,
    })),
  });
}
