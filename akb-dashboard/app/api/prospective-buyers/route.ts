import { NextResponse } from "next/server";
import { getProspectiveBuyers } from "@/lib/airtable";

export async function GET() {
  try {
    const buyers = await getProspectiveBuyers();
    return NextResponse.json(buyers);
  } catch (error) {
    console.error("Failed to fetch prospective buyers:", error);
    return NextResponse.json(
      { error: "Failed to fetch prospective buyers" },
      { status: 500 }
    );
  }
}
