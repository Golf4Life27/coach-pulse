import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";

// Defaults to the v2 active surface (INV-LEGACY-BACKSTOP). Pass
// ?include_legacy=true to include the v1 legacy backstop records.
export async function GET(req: Request) {
  try {
    const includeLegacy = new URL(req.url).searchParams.get("include_legacy") === "true";
    const listings = await getListings({ includeLegacy });
    return NextResponse.json(listings);
  } catch (error) {
    console.error("Failed to fetch listings:", error);
    return NextResponse.json(
      { error: "Failed to fetch listings" },
      { status: 500 }
    );
  }
}
