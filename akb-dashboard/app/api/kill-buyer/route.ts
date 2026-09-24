import { NextResponse } from "next/server";
import { requireSendAuth } from "@/lib/send-route-auth";
import { updateProspectiveBuyerRecord } from "@/lib/airtable";

export async function POST(request: Request) {
  const auth = await requireSendAuth(request);
  if (!auth.ok) return auth.response;

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
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[kill-buyer] Failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
