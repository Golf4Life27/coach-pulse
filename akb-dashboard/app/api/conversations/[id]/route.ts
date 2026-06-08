import { getListing, getListings } from "@/lib/airtable";
import { getThreadVerified } from "@/lib/quo";
import { getThreadsForEmail } from "@/lib/gmail";
import { parseConversation } from "@/lib/notes";
import { mergeTimeline, type SiblingRecord } from "@/lib/timeline-merge";

export const runtime = "nodejs";
export const maxDuration = 30;

interface UnifiedMessage {
  id: string;
  source: "quo" | "email" | "notes";
  direction: "inbound" | "outbound" | "system";
  body: string;
  timestamp: string;
  from: string;
  to: string;
  subject?: string;
}

function cleanPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || !id.startsWith("rec")) {
    return Response.json({ error: "Invalid record ID" }, { status: 400 });
  }

  try {
    const listing = await getListing(id);
    if (!listing) {
      return Response.json({ error: "Listing not found" }, { status: 404 });
    }

    // Sibling listings (same Agent_Phone) so each cross-channel message is
    // attributed to a specific property — keeps THIS property's thread clean
    // when an agent holds several listings.
    let siblings: SiblingRecord[] = [];
    if (listing.agentPhone) {
      try {
        const all = await getListings();
        const target = cleanPhone(listing.agentPhone);
        siblings = all
          .filter((l) => l.id !== id && l.agentPhone && cleanPhone(l.agentPhone) === target)
          .map((l) => ({
            recordId: l.id,
            address: l.address,
            candidatePrices: [l.listPrice, l.outreachOfferPrice ?? null].filter(
              (n): n is number => typeof n === "number" && n > 0,
            ),
          }));
      } catch (err) {
        console.error(`[conversations] Sibling lookup failed for ${id}:`, err);
      }
    }

    // 1. Texts — RELIABLE read path (wire #3): verify each message by id.
    let quoMessages: Awaited<ReturnType<typeof getThreadVerified>>["messages"] = [];
    if (listing.agentPhone && process.env.QUO_API_KEY) {
      try {
        const phone = cleanPhone(listing.agentPhone);
        const thread = await getThreadVerified(phone, 60 * 24 * 90, 60); // 90 days
        quoMessages = thread.messages;
      } catch (err) {
        console.error(`[conversations] Quo error for ${id}:`, err);
      }
    }

    // 2. Gmail — live email thread with the agent (returns [] if Gmail not
    // configured). Wire #4: email now threads INTO the conversation, not just
    // status signals.
    let gmailMessages: Awaited<ReturnType<typeof getThreadsForEmail>> = [];
    if (listing.agentEmail) {
      try {
        gmailMessages = await getThreadsForEmail(listing.agentEmail);
      } catch (err) {
        console.error(`[conversations] Gmail error for ${id}:`, err);
      }
    }

    // 3. Notes — emails/SMS/manual entries already logged to the record
    // (durable backstop; deduped against the live pulls by the merge engine).
    const notesEntries = listing.notes ? parseConversation(listing.notes) : [];

    // Single merge engine: texts + Gmail + notes, deduped, attributed, and
    // SORTED STRICTLY BY TIMESTAMP — so a $100 text 5:00, a $101 email 5:01,
    // and an "ok send it" text 5:02 thread in that exact order regardless of
    // channel. This sequencing is the source of truth downstream logic reads.
    const { timeline } = mergeTimeline(quoMessages, gmailMessages, notesEntries, {
      recordId: id,
      targetAddress: listing.address,
      // INV-016: include the OUTREACH OFFER alongside list price — H2
      // bodies cite the offer (≈65% of list), so a seller-agent reply
      // citing our number now triggers the +0.3 price-match bonus.
      targetPrices: [listing.listPrice, listing.outreachOfferPrice ?? null].filter(
        (n): n is number => typeof n === "number" && n > 0,
      ),
      agentName: listing.agentName ?? null,
      siblings,
    });

    // Keep only entries confidently attributed to THIS property (sibling- or
    // low-confidence messages stay out of this thread; they remain visible via
    // the AMBIGUOUS banner on /pipeline/[id]). Notes/system carry confidence
    // 1.0 for this record, so they always pass.
    const channelToSource: Record<string, "quo" | "email" | "notes"> = {
      sms: "quo", email: "email", note: "notes", system: "notes",
    };
    const messages: UnifiedMessage[] = timeline
      .filter((e) => e.propertyMatch.recordId === id && e.propertyMatch.confidence >= 0.6)
      .map((e, i) => {
        const source = channelToSource[e.channel] ?? "notes";
        const direction: UnifiedMessage["direction"] =
          e.channel === "system" ? "system" : e.direction === "in" ? "inbound" : "outbound";
        const rawId = (e.raw as { id?: string } | undefined)?.id;
        const msg: UnifiedMessage = {
          id: `${e.channel}-${i}-${rawId ?? "x"}`,
          source,
          direction,
          body: e.body,
          timestamp: e.timestamp,
          from: e.sender,
          to: direction === "inbound" ? "Alex (AKB)" : (listing.agentName ?? "Agent"),
        };
        if (e.subject) msg.subject = e.subject;
        return msg;
      });

    return Response.json({
      recordId: id,
      address: listing.address,
      agentName: listing.agentName,
      agentPhone: listing.agentPhone,
      agentEmail: listing.agentEmail,
      messageCount: messages.length,
      quoCount: messages.filter((m) => m.source === "quo").length,
      emailCount: messages.filter((m) => m.source === "email").length,
      notesCount: messages.filter((m) => m.source === "notes").length,
      messages,
    });
  } catch (err) {
    console.error(`[conversations] Error for ${id}:`, err);
    return Response.json(
      { error: "Failed to load conversations", detail: String(err) },
      { status: 500 }
    );
  }
}
