import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";

export async function GET() {
  try {
    const listings = await getListings();
    return NextResponse.json(listings);
  } catch (error) {
    console.error("Failed to fetch listings:", error);
    return NextResponse.json(
      { error: "Failed to fetch listings" },
      { status: 500 }
    );
  }
}
