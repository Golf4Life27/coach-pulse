// D3 Follow-Up Cadence — dry-run report endpoint.
//
// GET /api/admin/d3-cadence?limit=N
//
// Pulls the Texted universe, runs Phase 0a scrub classification +
// cadence classification on each, returns action distribution. Pure
// report — no sends, no writes regardless of params. Templates remain
// DRAFT in scripts/outreach/ until Alex approval; this endpoint shows
// what WOULD fire if cadence were live.
//
// Two principles per Spine recmmidVrMyrLzjZp + recxxNF0U59MxYUqu:
//   - 65% Rule: opening offer at outreach = List_Price × 0.65.
//   - Offer Discipline: stored OfferPrice is sticky; seller-side price
//     drops route to follow_up_drift_down, not OfferPrice recompute.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { classifyTexted } from "@/lib/d3-scrub";
import { classifyCadence, summarizeCadence, type CadenceDecision } from "@/lib/d3-cadence";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 0) : null;

  const allListings = await getListings();
  const texted = allListings.filter(
    (l) => (l.outreachStatus ?? "").toLowerCase() === "texted",
  );
  const subset = limit != null ? texted.slice(0, limit) : texted;

  const now = new Date();
  const decisions: CadenceDecision[] = subset.map((l) => {
    const scrub = classifyTexted(l);
    return classifyCadence({ listing: l, bucket: scrub.bucket, now });
  });
  const summary = summarizeCadence(decisions);

  await audit({
    agent: "d3-cadence",
    event: "cadence_report_run",
    status: "confirmed_success",
    inputSummary: {
      limit,
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
    // Per-record decisions capped at 200; full set lives in audit log.
    decisions_sample: decisions.slice(0, 200).map((d) => ({
      recordId: d.recordId,
      action: d.action,
      template_id: d.template_id,
      banner: d.banner,
      reasoning: d.reasoning,
      schema_gaps: d.schema_gaps,
    })),
  });
}
