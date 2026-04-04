import { NextResponse } from "next/server";
import { updateListingRecord } from "@/lib/airtable";

export async function POST(request: Request) {
  try {
    const { recordId } = await request.json();
    if (!recordId) {
      return NextResponse.json({ error: "Missing recordId" }, { status: 400 });
    }

    await updateListingRecord(recordId, {
      fldGIgqwyCJg4uFyv: "Dead",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to mark dead:", error);
    return NextResponse.json(
      { error: "Failed to update record" },
      { status: 500 }
    );
  }
}
