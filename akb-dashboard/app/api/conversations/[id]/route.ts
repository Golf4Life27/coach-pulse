import { getListing } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";
import { parseConversation } from "@/lib/notes";

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

    const messages: UnifiedMessage[] = [];

    // 1. Pull Quo SMS messages if agent phone exists
    if (listing.agentPhone && process.env.QUO_API_KEY) {
      try {
        const phone = cleanPhone(listing.agentPhone);
        const quoMessages = await getMessagesForParticipant(phone, 60 * 24 * 90); // 90 days
        for (const msg of quoMessages) {
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
