import { NextResponse } from "next/server";
import { updateProspectiveBuyerRecord } from "@/lib/airtable";

export async function POST(request: Request) {
  try {
    const { recordId } = await request.json();
    if (!recordId) {
      return NextResponse.json({ error: "Missing recordId" }, { status: 400 });
    }

    await updateProspectiveBuyerRecord(recordId, {
      fld3mac8sg2dWtX0z: "Not Interested",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to kill buyer:", error);
    return NextResponse.json(
      { error: "Failed to update record" },
      { status: 500 }
    );
  }
}
