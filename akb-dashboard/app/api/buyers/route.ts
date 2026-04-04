import { NextResponse } from "next/server";
import { getBuyers } from "@/lib/airtable";

export async function GET() {
  try {
    const buyers = await getBuyers();
    return NextResponse.json(buyers);
  } catch (error) {
    console.error("Failed to fetch buyers:", error);
    return NextResponse.json(
      { error: "Failed to fetch buyers" },
      { status: 500 }
    );
  }
}
