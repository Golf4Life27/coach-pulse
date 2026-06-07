import { getListing, getListings } from "@/lib/airtable";
import { getThreadVerified } from "@/lib/quo";
import { parseConversation } from "@/lib/notes";
import { scorePropertyMatch, type SiblingRecord } from "@/lib/timeline-merge";

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

    // INV-007 Step 1 attribution filter: pull sibling listings (same Agent_Phone)
    // so we can attribute each Quo message to a specific property. Filter out
    // messages that score to a sibling OR fall below the 0.6 confidence floor
    // (same threshold the AMBIGUOUS banner uses in /api/deal-context/[id]).
    // Step 2 (unified attribution layer at ingest) deferred to belt MVP sprint.
    let siblings: SiblingRecord[] = [];
    if (listing.agentPhone) {
      try {
        const all = await getListings();
        const target = cleanPhone(listing.agentPhone);
        siblings = all
          .filter((l) => l.id !== id && l.agentPhone && cleanPhone(l.agentPhone) === target)
          .map((l) => ({ recordId: l.id, address: l.address, listPrice: l.listPrice }));
      } catch (err) {
        console.error(`[conversations] Sibling lookup failed for ${id}:`, err);
      }
    }
    const hasSiblings = siblings.length > 0;

    const messages: UnifiedMessage[] = [];

    // 1. Pull Quo SMS messages if agent phone exists
    if (listing.agentPhone && process.env.QUO_API_KEY) {
      try {
        const phone = cleanPhone(listing.agentPhone);
        // Wire #3 (SYSTEM_HANDOFF.md): use the RELIABLE read path. The old
        // getMessagesForParticipant feed silently dropped delivered messages;
        // getThreadVerified re-looks-up each id (drops phantoms, catches body
        // divergence). The notes-merge below remains the durable backstop for
        // anything the live feed still misses (the sync cron writes verified
        // messages into Verification_Notes).
        const thread = await getThreadVerified(phone, 60 * 24 * 90, 60); // 90 days, cap lookups for page-load latency
        const quoMessages = thread.messages;
        for (const msg of quoMessages) {
          // Attribute via scorePropertyMatch when this agent holds multiple listings.
          // match.recordId === "" means target won; empty fallback to current id.
          // Sibling-attributed OR low-confidence (<0.6) messages are excluded from
          // this property's thread. They remain visible via the AMBIGUOUS banner
          // on /pipeline/[id] and the disambiguation queue.
          if (hasSiblings) {
            const match = scorePropertyMatch(
              msg.body,
              listing.address,
              listing.listPrice,
              siblings,
            );
            const attributedRecordId = match.recordId || id;
            if (attributedRecordId !== id || match.confidence < 0.6) continue;
          }
          messages.push({
            id: `quo-${msg.id}`,
            source: "quo",
            direction: msg.direction === "incoming" ? "inbound" : "outbound",
            body: msg.body,
            timestamp: msg.createdAt,
            from: msg.direction === "incoming" ? (listing.agentName ?? msg.from) : "Alex (AKB)",
            to: msg.direction === "incoming" ? "Alex (AKB)" : (listing.agentName ?? msg.to),
          });
        }
      } catch (err) {
        console.error(`[conversations] Quo error for ${id}:`, err);
      }
    }

    // 2. Parse Notes for conversation entries (covers emails + manual logs)
    if (listing.notes) {
      const entries = parseConversation(listing.notes);
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        if (entry.type === "system") {
          messages.push({
            id: `notes-sys-${i}`,
            source: "notes",
            direction: "system",
            body: entry.text,
            timestamp: entry.timestamp ?? "",
            from: "System",
            to: "",
          });
          continue;
        }

        // Dedup: skip if a Quo message with similar body exists
        const isDupe = messages.some(
          (m) =>
            m.source === "quo" &&
            m.direction === (entry.type === "inbound" ? "inbound" : "outbound") &&
            entry.text.length > 10 &&
            (m.body.includes(entry.text.slice(0, 30)) || entry.text.includes(m.body.slice(0, 30)))
        );

        if (!isDupe) {
          messages.push({
            id: `notes-${i}`,
            source: "notes",
            direction: entry.type === "inbound" ? "inbound" : entry.type === "outbound" ? "outbound" : "system",
            body: entry.text,
            timestamp: entry.timestamp ?? "",
            from: entry.type === "inbound" ? (listing.agentName ?? "Agent") : "Alex (AKB)",
            to: entry.type === "inbound" ? "Alex (AKB)" : (listing.agentName ?? "Agent"),
          });
        }
      }
    }

    // 3. Sort by timestamp (oldest first)
    messages.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return -1;
      if (!b.timestamp) return 1;
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });

    return Response.json({
      recordId: id,
      address: listing.address,
      agentName: listing.agentName,
      agentPhone: listing.agentPhone,
      agentEmail: listing.agentEmail,
      messageCount: messages.length,
      quoCount: messages.filter((m) => m.source === "quo").length,
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
