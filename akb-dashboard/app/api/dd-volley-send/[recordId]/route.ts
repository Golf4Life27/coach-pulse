import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { sendMessage } from "@/lib/quo";
import { getVolleyText } from "@/lib/dd-volley";

export const runtime = "nodejs";
export const maxDuration = 30;

const FIELD_BY_INDEX: Record<1 | 2 | 3, string> = {
  1: "DD_Volley_Text_1_Sent_At",
  2: "DD_Volley_Text_2_Sent_At",
  3: "DD_Volley_Text_3_Sent_At",
};

function cleanPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

function todayStamp(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "2-digit",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

interface Body {
  textIndex: 1 | 2 | 3;
  override?: boolean;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const { recordId } = await params;
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", recordId }, { status: 400 });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (![1, 2, 3].includes(body.textIndex)) {
    return NextResponse.json({ error: "textIndex must be 1, 2, or 3" }, { status: 400 });
  }

  if (!process.env.QUO_API_KEY) {
    return NextResponse.json({ error: "QUO_API_KEY not set" }, { status: 500 });
  }

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found", recordId }, { status: 404 });
  }
  if (!listing.agentPhone) {
    return NextResponse.json({ error: "Listing has no agent phone" }, { status: 400 });
  }

  const content = getVolleyText(body.textIndex, listing.agentName);

  try {
    await sendMessage(cleanPhone(listing.agentPhone), content);
  } catch (err) {
    console.error(`[dd-volley-send] Quo send failed for ${recordId}:`, err);
    return NextResponse.json(
      { error: "Failed to send via Quo", detail: String(err) },
      { status: 502 },
    );
  }

  const sentAt = new Date().toISOString();

  // Append to Notes + stamp the per-text field.
  const noteLine = `${todayStamp()} — DD Volley Text ${body.textIndex} sent: ${content}`;
  const fields: Record<string, unknown> = {
    [FIELD_BY_INDEX[body.textIndex]]: sentAt,
    Last_Outbound_At: sentAt,
  };
  // Append note (read-modify-write).
  const existingNotes = listing.notes ?? "";
  fields.Verification_Notes = existingNotes ? `${existingNotes}\n${noteLine}` : noteLine;

  try {
    await updateListingRecord(recordId, fields);
  } catch (err) {
    console.error(`[dd-volley-send] Failed to persist for ${recordId}:`, err);
  }

  return NextResponse.json({
    sent: true,
    textIndex: body.textIndex,
    content,
    sentAt,
  });
}
