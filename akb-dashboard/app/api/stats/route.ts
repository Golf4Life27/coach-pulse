import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { DashboardStats } from "@/lib/types";

export async function GET() {
  try {
    const listings = await getListings();

    const stats: DashboardStats = {
      negotiating: listings.filter((l) => l.outreachStatus === "Negotiating").length,
      responseReceived: listings.filter((l) => l.outreachStatus === "Response Received").length,
      textedEmailed: listings.filter(
        (l) => l.outreachStatus === "Texted" || l.outreachStatus === "Emailed"
      ).length,
      dead: listings.filter((l) => l.outreachStatus === "Dead").length,
      totalRecords: listings.length,
      verifiedActive: listings.filter((l) => l.liveStatus === "Active").length,
      autoProceed: listings.filter((l) => l.executionPath === "Auto Proceed").length,
      manualReview: listings.filter((l) => l.executionPath === "Manual Review").length,
      rejected: listings.filter((l) => l.executionPath === "Reject").length,
    };

    return NextResponse.json(stats);
  } catch (error) {
    console.error("Failed to fetch stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch stats" },
      { status: 500 }
    );
  }
}
