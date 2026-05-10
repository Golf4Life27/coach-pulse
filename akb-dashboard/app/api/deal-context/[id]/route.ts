import { NextResponse } from "next/server";
import { getListing, getListings } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";
import { getThreadsForEmail } from "@/lib/gmail";
import { parseConversation } from "@/lib/notes";
import { mergeTimeline, computeResponseStatus } from "@/lib/timeline-merge";
import type { DealContext } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 30;

const CACHE_TTL_MS = 60_000;
const cache: Record<string, { data: DealContext; timestamp: number }> = {};

function cleanPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!id || !id.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", id }, { status: 400 });
  }

  const cached = cache[id];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  try {
    const listing = await getListing(id);
    if (!listing) {
      return NextResponse.json({ error: "Listing not found", id }, { status: 404 });
    }

    // Multi-listing detection — find sibling records with the same agent phone.
    let siblings: { recordId: string; address: string; listPrice: number | null }[] = [];
    if (listing.agentPhone) {
      try {
        const all = await getListings();
        const target = cleanPhone(listing.agentPhone);
        siblings = all
          .filter((l) => l.id !== id && l.agentPhone && cleanPhone(l.agentPhone) === target)
          .map((l) => ({ recordId: l.id, address: l.address, listPrice: l.listPrice }));
      } catch (err) {
        console.error(`[deal-context] Sibling lookup failed for ${id}:`, err);
      }
    }

    // Pull Quo messages.
    let quoMessages: Awaited<ReturnType<typeof getMessagesForParticipant>> = [];
    if (listing.agentPhone && process.env.QUO_API_KEY) {
      try {
        quoMessages = await getMessagesForParticipant(
          cleanPhone(listing.agentPhone),
          60 * 24 * 90, // 90 days
        );
      } catch (err) {
        console.error(`[deal-context] Quo fetch failed for ${id}:`, err);
      }
    }

    // Pull Gmail threads. Requires GMAIL_REFRESH_TOKEN issued with the
    // gmail.readonly scope; returns [] otherwise (see lib/gmail.ts).
    let gmailMessages: Awaited<ReturnType<typeof getThreadsForEmail>> = [];
    if (listing.agentEmail) {
      try {
        gmailMessages = await getThreadsForEmail(listing.agentEmail);
      } catch (err) {
        console.error(`[deal-context] Gmail fetch failed for ${id}:`, err);
      }
    }

    // Parse Notes for conversation entries.
    const noteEntries = parseConversation(listing.notes).map((e) => ({
      type: e.type,
      text: e.text,
      timestamp: e.timestamp,
    }));

    const { timeline, ambiguous } = mergeTimeline(
      quoMessages,
      gmailMessages,
      noteEntries,
      {
        recordId: id,
        targetAddress: listing.address,
        targetPrice: listing.listPrice,
        agentName: listing.agentName,
        siblings,
      },
    );

    const status = computeResponseStatus(timeline);

    const context: DealContext = {
      recordId: id,
      agent: {
        name: listing.agentName,
        phone: listing.agentPhone,
        email: listing.agentEmail,
      },
      property: {
        address: listing.address,
        city: listing.city,
        state: listing.state,
        listPrice: listing.listPrice,
      },
      timeline,
      ambiguousMessages: ambiguous,
      lastInbound: status.lastInbound,
      lastOutbound: status.lastOutbound,
      hoursSinceInbound: status.hoursSinceInbound,
      hoursSinceOutbound: status.hoursSinceOutbound,
      responseDue: status.responseDue,
      multiListingAlert: siblings.length > 0,
      siblingRecords: siblings.map((s) => ({ recordId: s.recordId, address: s.address })),
      metadata: {
        outreachStatus: listing.outreachStatus,
        lastInboundBody: status.lastInboundBody,
        lastOutreachDate: listing.lastOutreachDate,
        listingLastInboundAt: listing.lastInboundAt,
        listingLastOutboundAt: listing.lastOutboundAt,
        quoCount: quoMessages.length,
        gmailCount: gmailMessages.length,
        notesCount: noteEntries.length,
      },
    };

    cache[id] = { data: context, timestamp: Date.now() };
    return NextResponse.json(context);
  } catch (err) {
    console.error(`[deal-context] Error for ${id}:`, err);
    return NextResponse.json(
      { error: "Failed to load deal context", detail: String(err), id },
      { status: 500 },
    );
  }
}
