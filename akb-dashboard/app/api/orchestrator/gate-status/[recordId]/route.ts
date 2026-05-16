// GET /api/orchestrator/gate-status/[recordId]
//
// Returns the listing's current Pipeline_Stage + a snapshot of which
// gate would run next + the listing's own data state that downstream
// gates would consume. Does NOT execute any gate (use run-gate for
// that).

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import {
  ALL_PIPELINE_STAGES,
  type PipelineStage,
} from "@/lib/orchestrator/types";

export const runtime = "nodejs";
export const maxDuration = 30;

// Stage progression — index of stage tells you which gate runs next.
// (intake → verified is Scenario A/B; verified → outreach_ready is
// Gate 1; outreach_ready → outreach_sent is Gate 2; etc.)
const STAGE_PROGRESSION_GATES: Record<string, string | null> = {
  intake: "verification (scenarioA/B)",
  verified: "pre_outreach",
  priced: "pre_outreach", // (or pre_send once Gate 2 lands)
  outreach_ready: "pre_send",
  outreach_sent: "pre_negotiation",
  negotiating: "pre_negotiation",
  offer_drafted: "pre_contract",
  under_contract: "pre_dispo",
  dispo_active: "pre_dispo",
  assignment_signed: null, // terminal positive
  closed: null,
  dead: null,
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const { recordId } = await params;
  if (!recordId.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid recordId" }, { status: 400 });
  }
  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found", recordId }, { status: 404 });
  }
  const stage = (listing.pipelineStage as PipelineStage | null | undefined) ?? null;
  const stageRecognized = stage != null && ALL_PIPELINE_STAGES.includes(stage);
  const nextGate = stageRecognized
    ? STAGE_PROGRESSION_GATES[stage] ?? null
    : "pre_outreach"; // null/unrecognized stages default to first gate

  return NextResponse.json({
    recordId,
    address: listing.address,
    current_stage: stage,
    stage_recognized: stageRecognized,
    next_gate: nextGate,
    // Field-level snapshot of inputs the next gate(s) would read.
    // Useful for the dashboard to render "what's missing" without
    // running the gate.
    gate_inputs: {
      mls_status: listing.mlsStatus ?? null,
      live_status: listing.liveStatus ?? null,
      last_verified: listing.lastVerified ?? null,
      off_market_override: listing.offMarketOverride ?? false,
      state: listing.state ?? null,
      property_type: listing.propertyType ?? null,
      bedrooms: listing.bedrooms ?? null,
      building_sqft: listing.buildingSqFt ?? null,
      list_price: listing.listPrice ?? null,
      agent_phone_present: listing.agentPhone != null && listing.agentPhone.length > 0,
      flip_score: listing.flipScore ?? null,
      dom: listing.dom ?? null,
      price_drop_count: listing.priceDropCount ?? null,
      do_not_text: listing.doNotText ?? false,
    },
    queried_at: new Date().toISOString(),
  });
}
