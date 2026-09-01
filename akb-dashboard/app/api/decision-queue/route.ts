import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { buildDecisionQueue, type ListingDecisionRow } from "@/lib/conveyor/decision-queue";

// The Decision Queue source (operator ruling 2026-09-01, directive §5):
// pending Tier C listing decisions — acceptances and counters — already
// conveyor-shaped. Server-side so the home screen never pulls the whole
// Listings_V1 table into the browser; the pure selection lives in
// lib/conveyor/decision-queue.
export const runtime = "nodejs";
export const maxDuration = 30;

type ListingLike = Awaited<ReturnType<typeof getListings>>[number];

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function toListingDecisionRow(l: ListingLike): ListingDecisionRow {
  const r = l as unknown as Record<string, unknown>;
  return {
    id: String(r.id),
    address: str(r.address),
    agentName: str(r.agentName),
    outreachStatus: str(r.outreachStatus),
    pipelineStage: str(r.pipelineStage),
    listPrice: num(r.listPrice),
    roughOpenerAmount: num(r.roughOpenerAmount),
    contractOfferPrice: num(r.contractOfferPrice),
    latestCounterUsd: num(r.latestCounterUsd),
    buyerCeiling: num(r.buyerCeiling),
    dealSpread: num(r.dealSpread),
    decisionVerdict: str(r.decisionVerdict),
    lastInboundAt: str(r.lastInboundAt),
    lastOutboundAt: str(r.lastOutboundAt),
    actionCardState: str(r.actionCardState),
    blacklist: r.blacklist === true,
    doNotText: r.doNotText === true,
  };
}

export async function GET() {
  try {
    const listings = await getListings();
    const items = buildDecisionQueue(listings.map(toListingDecisionRow), new Date().toISOString());
    return NextResponse.json({ items, count: items.length });
  } catch (error) {
    console.error("[decision-queue] failed:", error);
    return NextResponse.json({ error: "Failed to build decision queue" }, { status: 500 });
  }
}
