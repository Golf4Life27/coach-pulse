import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { buildDecisionQueue, toListingDecisionRow } from "@/lib/conveyor/decision-queue";

// The Decision Queue source (operator ruling 2026-09-01, directive §5):
// pending Tier C listing decisions — acceptances and counters — already
// conveyor-shaped. Server-side so the home screen never pulls the whole
// Listings_V1 table into the browser; the pure selection lives in
// lib/conveyor/decision-queue.
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  try {
    const listings = await getListings();
    const rows = listings.map((l) => toListingDecisionRow(l as unknown as { id: string } & Record<string, unknown>));
    const items = buildDecisionQueue(rows, new Date().toISOString());
    return NextResponse.json({ items, count: items.length });
  } catch (error) {
    console.error("[decision-queue] failed:", error);
    return NextResponse.json({ error: "Failed to build decision queue" }, { status: 500 });
  }
}
