import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || !id.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id" }, { status: 400 });
  }
  try {
    const listing = await getListing(id);
    if (!listing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(listing);
  } catch (err) {
    console.error("[listings/id] error:", err);
    return NextResponse.json(
      { error: "Failed to fetch listing", detail: String(err) },
      { status: 500 },
    );
  }
}
