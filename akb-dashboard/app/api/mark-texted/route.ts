import { NextResponse } from "next/server";
import { updateListingRecord } from "@/lib/airtable";

export async function POST(request: Request) {
  try {
    const { recordId } = await request.json();
    if (!recordId) {
      return NextResponse.json({ error: "Missing recordId" }, { status: 400 });
    }

    const today = new Date().toISOString().split("T")[0];

    await updateListingRecord(recordId, {
      fldGIgqwyCJg4uFyv: "Texted",
      fldbRrOW3IEoLtnFE: today,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[mark-texted] Failed:", message);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
