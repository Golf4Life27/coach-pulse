import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { getBuyerV2, updateBuyerV2, BUYER_V2_FIELDS } from "@/lib/buyers-v2";
import { sendMessage } from "@/lib/quo";
import { sendEmail } from "@/lib/gmail";
import type { BuyerBlastResult, BuyerDraft } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 120;

interface FireBody {
  drafts: Array<BuyerDraft & { send: boolean }>;
  assignmentPrice: number;
}

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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const { recordId } = await params;
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", recordId }, { status: 400 });
  }

  let body: FireBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found", recordId }, { status: 404 });
  }

  const toSend = (body.drafts ?? []).filter((d) => d.send);
  const results: BuyerBlastResult["results"] = [];
  const noteLines: string[] = [];
  let sent = 0;
  let failed = 0;

  for (const d of toSend) {
    const buyer = await getBuyerV2(d.buyerId);
    if (!buyer) {
      results.push({ buyerId: d.buyerId, success: false, error: "Buyer not found" });
      failed++;
      continue;
    }
    try {
      if (d.channel === "sms") {
        const phone = d.buyerPhone ?? buyer.phonePrimary;
        if (!phone) throw new Error("No phone");
        if (!process.env.QUO_API_KEY) throw new Error("QUO_API_KEY not set");
        await sendMessage(cleanPhone(phone), d.body);
        results.push({ buyerId: d.buyerId, success: true });
      } else {
        const email = d.buyerEmail ?? buyer.email;
        if (!email) throw new Error("No email");
        const r = await sendEmail({
          to: email,
          subject: d.subject ?? `Off-market deal — ${listing.address}`,
          body: d.body,
        });
        if (!r.success) throw new Error(r.error ?? "Gmail send failed");
        results.push({ buyerId: d.buyerId, success: true });
      }
      // Stamp Buyer record
      const nowIso = new Date().toISOString();
      await updateBuyerV2(buyer.id, {
        [BUYER_V2_FIELDS.Email_Sent_At]: nowIso,
        [BUYER_V2_FIELDS.Last_Engagement_At]: nowIso,
        [BUYER_V2_FIELDS.Status]: buyer.status === "Cold" ? "Warmed" : (buyer.status ?? "Warmed"),
      });
      noteLines.push(`${todayStamp()} — Buyer blast: sent to ${buyer.name} @ ${d.channel === "sms" ? (d.buyerPhone ?? buyer.phonePrimary) : (d.buyerEmail ?? buyer.email)}`);
      sent++;
    } catch (err) {
      results.push({ buyerId: d.buyerId, success: false, error: String(err) });
      failed++;
    }
  }

  // Append blast log to listing Notes.
  if (noteLines.length > 0) {
    const existingNotes = listing.notes ?? "";
    try {
      await updateListingRecord(recordId, {
        Verification_Notes: existingNotes ? `${existingNotes}\n${noteLines.join("\n")}` : noteLines.join("\n"),
      });
    } catch (err) {
      console.error(`[buyers/fire-blast] Failed to update listing notes:`, err);
    }
  }

  const result: BuyerBlastResult = { recordId, sent, failed, results };
  return NextResponse.json(result);
}
