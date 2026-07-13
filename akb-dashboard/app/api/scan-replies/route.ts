import { getListings, updateListingRecord } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";
import { isSelfEchoOrAutoreply } from "@/lib/conversation-check";
import {
  classifyReply,
  determineNewStatus,
  type ReplyClassification,
} from "@/lib/reply-triage";
import {
  autoRunOnEngaged,
  originFromRequest,
  type EngagedAutoRunResult,
} from "@/lib/appraiser/auto-run-on-engaged";

export const runtime = "nodejs";
// 300 (plan ceiling) — raised from 60 with the auto-run-on-engaged kick
// (2026-06-10 ruling): a Texted → Response Received transition now runs
// ARV inline (~15s) and, budget permitting, an awaited vision rehab
// (1-3 min). Transitions are rare (a few per day), so the Quo scan
// itself still finishes in the old 60s envelope on a normal tick.
export const maxDuration = 300;

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

  return handleScan(req);
}

export async function POST(req: Request) {
  return handleScan(req);
}

async function handleScan(req: Request) {
  if (!AIRTABLE_PAT) {
    return Response.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }
  if (!process.env.QUO_API_KEY) {
    return Response.json({ error: "QUO_API_KEY not set" }, { status: 500 });
  }

  try {
    const listings = await getListings();

    // Only check listings that have been texted and have agent phones.
    // Parked added 2026-06-14 (rebuild-stale-deal-handling): a Parked
    // record is a Texted record that's gone quiet and entered the cold
    // follow-up loop — if the agent finally replies, scan-replies must
    // pick it up so autoRunOnEngaged fires the re-price.
    const CHECKABLE_STATUSES = new Set([
      "Texted", "Response Received", "Negotiating", "Offer Accepted", "Emailed", "Parked",
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
    // 2026-06-10 ruling — auto-run Appraiser on Texted → Response Received.
    // ARV is awaited inline (fresh number needed before the alert lands);
    // rehab is awaited too when the remaining lambda budget fits a vision
    // run, else skipped with a recorded reason (the panel's manual button
    // is the prepared one-click fallback). NO fire-and-forget — see
    // lib/appraiser/auto-run-on-engaged.ts.
    const autoRunResults: EngagedAutoRunResult[] = [];
    const origin = originFromRequest(req);
    // 10s reserve for the closing Airtable writes + JSON response.
    const deadlineAtMs = Date.now() + maxDuration * 1000 - 10_000;

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
            : classification === "soft_no" ? "SOFT-NO (re-engage queued)"
            : classification === "interest" ? "INTEREST"
            : classification === "counter" ? "COUNTER"
            : classification === "acceptance" ? "ACCEPTANCE"
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
            // Event-driven Appraiser kick — on any transition INTO an
            // ENGAGED stage (Response Received OR straight to Negotiating /
            // Counter Received / Offer Accepted). Ruling 2026-06-10: the
            // reply is the gate. Broadened 2026-07-13 (P1.2) — an interest
            // reply that jumps directly to Negotiating was silently skipped;
            // the auto-underwrite-engaged cron is the channel-agnostic
            // backstop for email/manual/legacy advances this path can't see.
            if (
              newStatus === "Response Received" ||
              newStatus === "Negotiating" ||
              newStatus === "Counter Received" ||
              newStatus === "Offer Accepted"
            ) {
              try {
                const r = await autoRunOnEngaged({
                  recordId: listing.id,
                  origin,
                  deadlineAtMs,
                });
                autoRunResults.push(r);
              } catch (err) {
                autoRunResults.push({
                  recordId: listing.id,
                  arvOk: false,
                  arvHttpStatus: null,
                  arvElapsedMs: 0,
                  arvError: String(err).slice(0, 240),
                  rehab: "failed",
                  rehabHttpStatus: null,
                  rehabElapsedMs: 0,
                  rehabError: String(err).slice(0, 240),
                  reprice: "failed",
                  repriceYourMao: null,
                  repriceElapsedMs: 0,
                  repriceError: String(err).slice(0, 240),
                  buyerIntel: "failed",
                  buyerIntelHttpStatus: null,
                  buyerIntelElapsedMs: 0,
                  buyerIntelError: String(err).slice(0, 240),
                });
              }
            }
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
      autoRunOnEngaged: autoRunResults.length > 0 ? {
        attempted: autoRunResults.length,
        arvOk: autoRunResults.filter((r) => r.arvOk).length,
        rehabOk: autoRunResults.filter((r) => r.rehab === "ok").length,
        rehabSkipped: autoRunResults.filter((r) => r.rehab.startsWith("skipped")).length,
        // Reply-triggered landlord re-price (Maverick 2026-06-14).
        repriceOk: autoRunResults.filter((r) => r.reprice === "ok").length,
        repriceHold: autoRunResults.filter((r) => r.reprice === "hold").length,
        repriceSkipped: autoRunResults.filter((r) => r.reprice.startsWith("skipped")).length,
        results: autoRunResults,
      } : undefined,
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
