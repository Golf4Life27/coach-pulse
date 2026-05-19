// Phase 4.5 + 4.6 / Q.5 — Scout dispo-readiness queue endpoint.
//
// GET /api/agents/scout/queue
//
// Lists active deals ready for dispo blast, scored + sorted. Pure
// read — no Anthropic calls, no Airtable writes. Per-record buyer
// matching still happens via /api/buyers/match-to-deal/[recordId]
// when operator clicks through.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { buildDispoQueue } from "@/lib/scout/queue";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const t0 = Date.now();
  const listings = await getListings();
  const queue = buildDispoQueue(listings);

  await audit({
    agent: "scout",
    event: "scout_queue_read",
    status: "confirmed_success",
    inputSummary: { listings_count: listings.length },
    outputSummary: {
      queue_count: queue.length,
      high_readiness_count: queue.filter((q) => q.readiness_score >= 75).length,
    },
    decision: "ok",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    queue_count: queue.length,
    queue,
  });
}
