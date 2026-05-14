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
import {
  classifyCadence,
  summarizeCadence,
  type CadenceDecision,
  type AgentInteractionMap,
} from "@/lib/d3-cadence";
import { normalizePhone } from "@/lib/phone-normalize";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

// Build the cross-listing agent-interaction map from the full Listings_V1
// universe (NOT just the Texted subset). Includes Texted + Negotiating
// records because both represent active engagement — a Negotiating
// record on Listing A means we ARE talking to the agent, so a cold
// status_check on Listing B is the same relationship-burn risk.
// Bypasses Agent_Prior_Outreach_Count (which the upstream Make scan
// computes without phone normalization).
function buildAgentInteractionMap(allListings: Listing[]): AgentInteractionMap {
  const map: AgentInteractionMap = new Map();
  for (const l of allListings) {
    const status = (l.outreachStatus ?? "").toLowerCase();
    if (status !== "texted" && status !== "negotiating") continue;
    const normalized = normalizePhone(l.agentPhone);
    if (!normalized) continue;
    const existing = map.get(normalized);
    if (existing) {
      existing.count++;
      existing.listingIds.push(l.id);
    } else {
      map.set(normalized, { count: 1, listingIds: [l.id] });
    }
  }
  return map;
}

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

  // Build the depth-gate lookup ONCE over the full Listings_V1 universe.
  const agentInteractionMap = buildAgentInteractionMap(allListings);

  const now = new Date();
  const decisions: CadenceDecision[] = subset.map((l) => {
    const scrub = classifyTexted(l);
    return classifyCadence({
      listing: l,
      bucket: scrub.bucket,
      agentInteractionMap,
      now,
    });
  });
  const summary = summarizeCadence(decisions);

  // Surface map size for sanity-checking warm cohort against the
  // expected ~48 from the 5/14 distribution scan.
  const interactionMapStats = {
    distinct_phones_in_texted_or_negotiating: agentInteractionMap.size,
    phones_with_more_than_one_listing: [...agentInteractionMap.values()].filter(
      (v) => v.count > 1,
    ).length,
  };

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
      interaction_map_stats: interactionMapStats,
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
    interaction_map_stats: interactionMapStats,
    // Per-record decisions capped at 200; full set lives in audit log.
    decisions_sample: decisions.slice(0, 200).map((d) => ({
      recordId: d.recordId,
      action: d.action,
      template_id: d.template_id,
      banner: d.banner,
      reasoning: d.reasoning,
    })),
  });
}
