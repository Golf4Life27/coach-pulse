import { getListings, updateListingRecord } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";
import { isSelfEchoOrAutoreply } from "@/lib/conversation-check";
import {
  classifyReply,
  determineNewStatus,
  type ReplyClassification,
} from "@/lib/reply-triage";

export const runtime = "nodejs";
export const maxDuration = 60;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

// Field IDs
const F = {
  outreachStatus: "fldGIgqwyCJg4uFyv",
  lastInboundAt: "fld3IhR1DXzcVuq6F",
  notes: "fldwKGxZly6O8qyPu",
};

// Max phones to check per run (stay within 60s timeout)
const MAX_PHONES_PER_RUN = 30;
const SCAN_WINDOW_MINUTES = 360; // 6 hours

function cleanPhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "").slice(-10);
}

function toE164(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function appendNote(existing: string | null, newNote: string): string {
  const today = new Date().toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "2-digit",
  });
  const stamped = `${today} — [Reply Triage] ${newNote}`;
  return existing ? `${existing}\n\n${stamped}` : stamped;
}

// --- Reply classification ---
// classifyReply + determineNewStatus moved to the shared lib/reply-triage.ts
// (single source of truth; scan-comms consumes the same module for proposal
// routing). Imported at the top of this file.

// --- Route handlers ---

interface ScanResult {
  recordId: string;
  address: string;
  agentName: string | null;
  inboundBody: string;
  classification: ReplyClassification;
  matchedPattern: string | null;
  previousStatus: string | null;
  newStatus: string | null;
}

export async function GET(req: Request) {
  // Optional cron secret check
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return handleScan();
}

export async function POST() {
  return handleScan();
}

async function handleScan() {
  if (!AIRTABLE_PAT) {
    return Response.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }
  if (!process.env.QUO_API_KEY) {
    return Response.json({ error: "QUO_API_KEY not set" }, { status: 500 });
  }

  try {
    const listings = await getListings();

    // Only check listings that have been texted and have agent phones
    const CHECKABLE_STATUSES = new Set([
      "Texted", "Response Received", "Negotiating", "Offer Accepted", "Emailed",
    ]);
    const checkable = listings.filter(
      (l) => l.agentPhone && CHECKABLE_STATUSES.has(l.outreachStatus ?? "")
    );

    // Build phone → listings map (dedupe phones)
    const phoneToListings = new Map<string, typeof checkable>();
    for (const listing of checkable) {
      const e164 = toE164(listing.agentPhone!);
      const existing = phoneToListings.get(e164) ?? [];
      existing.push(listing);
      phoneToListings.set(e164, existing);
    }

    const phones = Array.from(phoneToListings.keys()).slice(0, MAX_PHONES_PER_RUN);

    let phonesChecked = 0;
    let inboundFound = 0;
    let statusUpdated = 0;
    let notesAppended = 0;
    const results: ScanResult[] = [];
    const errors: string[] = [];

    for (const phone of phones) {
      phonesChecked++;
      try {
        const messages = await getMessagesForParticipant(phone, SCAN_WINDOW_MINUTES);

        // Find the most recent GENUINE inbound — skip self-echo + bot
        // autoreply so they don't false-transition Texted → Response
        // Received (the conversation-check fix, live on the inbound path).
        const inbound = messages.find(
          (m) => m.direction === "incoming" && !isSelfEchoOrAutoreply(m.body),
        );
        if (!inbound) continue;
        inboundFound++;

        const matchedListings = phoneToListings.get(phone) ?? [];
        for (const listing of matchedListings) {
          const { classification, matchedPattern } = classifyReply(inbound.body);
          const newStatus = determineNewStatus(classification, listing.outreachStatus);

          const fields: Record<string, unknown> = {
            [F.lastInboundAt]: new Date().toISOString(),
          };

          // Build note
          const classLabel = classification === "rejection" ? "REJECTION"
            : classification === "interest" ? "INTEREST"
            : "UNCLASSIFIED";
          const noteText = `Inbound from ${listing.agentName ?? "agent"}: "${inbound.body.slice(0, 300)}". Classified: ${classLabel}.${newStatus ? ` Status → ${newStatus}.` : " Status unchanged."}`;

          fields[F.notes] = appendNote(listing.notes, noteText);

          if (newStatus) {
            fields[F.outreachStatus] = newStatus;
            statusUpdated++;
          }

          try {
            await updateListingRecord(listing.id, fields);
            notesAppended++;
          } catch (err) {
            errors.push(`${listing.address}: ${String(err)}`);
          }

          results.push({
            recordId: listing.id,
            address: listing.address,
            agentName: listing.agentName,
            inboundBody: inbound.body.slice(0, 200),
            classification,
            matchedPattern,
            previousStatus: listing.outreachStatus,
            newStatus,
          });
        }
      } catch (err) {
        errors.push(`Phone ${phone}: ${String(err)}`);
      }
    }

    return Response.json({
      phonesInPool: phoneToListings.size,
      phonesChecked,
      inboundFound,
      statusUpdated,
      notesAppended,
      results,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[scan-replies] Error:", err);
    return Response.json(
      { error: "Scan failed", detail: String(err) },
      { status: 500 }
    );
  }
}
