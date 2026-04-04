import { NextResponse } from "next/server";
import { getDeals } from "@/lib/airtable";

export async function GET() {
  try {
    const deals = await getDeals();
    return NextResponse.json(deals);
  } catch (error) {
    console.error("Failed to fetch deals:", error);
    return NextResponse.json(
      { error: "Failed to fetch deals" },
      { status: 500 }
    );
  }
}
