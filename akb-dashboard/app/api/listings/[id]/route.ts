import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  console.log(`[listings/id] Fetching record: ${id}`);

  if (!id || !id.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", id }, { status: 400 });
  }
  try {
    // fresh: the deal room is the operator's live working surface — a 60s
    // stale copy after an underwrite/write reads as "the button did nothing"
    // (1122 West Ave, 2026-07-17). One record, one Airtable GET; always live.
    const listing = await getListing(id, { fresh: true });
    if (!listing) {
      console.log(`[listings/id] Record ${id} not found`);
      return NextResponse.json({ error: "Not found", id }, { status: 404 });
    }
    return NextResponse.json(listing);
  } catch (err) {
    console.error(`[listings/id] Error fetching ${id}:`, err);
    return NextResponse.json(
      { error: "Failed to fetch listing", detail: String(err), id },
      { status: 500 },
    );
  }
}
