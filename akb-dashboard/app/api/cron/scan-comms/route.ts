import { getListings, updateListingRecord } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";
import { synthesize } from "@/lib/maverick/synthesizer";
// toE164 moved to lib/phone.ts on 2026-06-08 — conversation-check shares it
// (it was calling Quo without normalization → empty threads on every record).
import { toE164 } from "@/lib/phone";

export const runtime = "nodejs";
export const maxDuration = 60;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const AIRTABLE_BATCH_SIZE = 10;
const MAX_PHONES_PER_RUN = 25;
const SCAN_WINDOW_MINUTES = 120;

function getProposalsTableId(): string | null {
  return process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
}

function cleanPhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "").slice(-10);
}

function formatCurrency(n: number | null | undefined): string {
  if (n == null) return "Unknown";
  return "$" + Math.round(n).toLocaleString("en-US");
}

async function generateDraftResponse(
  listing: {
    address: string;
    agentName: string | null;
    listPrice: number | null;
    mao: number | null;
    notes: string | null;
  },
  inboundMessage: string
): Promise<string> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return "[No API key — draft not generated]";

  const systemPrompt = `You are an AI assistant for AKB Solutions LLC, a real estate wholesale operation run by Alex Balog. Your job is to draft short, professional text message responses to listing agents.

Rules:
- Use 65% of List Price as the offer number
- Never use the word "assignable" — say "affiliated entity" instead
- Never disclose wholesale fee, spread, or contract price to agents
- Keep responses under 3 sentences unless the situation requires more
- Be professional but casual — these are text messages, not emails
- Always include an inspection period (10 days) in any offer terms
- Never waive inspection/option periods
- If the agent is countering, you can acknowledge but Alex makes all pricing decisions — draft a response that keeps the conversation alive without committing to a new number
- Start with "Hey [FirstName]," — extract the first name from the agent name`;

  const userPrompt = `Property: ${listing.address}
Agent: ${listing.agentName || "Unknown"}
List Price: ${formatCurrency(listing.listPrice)}
Our MAO: ${formatCurrency(listing.mao)}
Recent Notes: ${(listing.notes || "").slice(-500)}

New inbound message from agent:
"${inboundMessage}"

Draft a text message response for Alex to review.`;

  try {
    // Phase 10 / P.2 migration — routed through unified synthesizer.
    const result = await synthesize({
      agent: "crier",
      system: systemPrompt,
      user: userPrompt,
      max_tokens: 300,
      apiKey: ANTHROPIC_API_KEY,
      event_label: "crier_reply_drafted",
    });
    return result.text || "[Draft generation failed]";
  } catch (err) {
    console.error("[Crier] AI draft error:", err);
    return "[Draft generation failed]";
  }
}

async function fetchExistingPendingProposals(
  tableId: string
): Promise<Set<string>> {
  const pending = new Set<string>();
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    params.set("filterByFormula", '{Status}="Pending"');
    params.set("fields[]", "Record_ID");
    params.append("fields[]", "Proposal_Type");
    if (offset) params.set("offset", offset);

    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${tableId}?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
        cache: "no-store",
      }
    );
    if (!res.ok) break;

    const data = await res.json();
    for (const rec of data.records) {
      const f = rec.fields as Record<string, unknown>;
      pending.add(`${f.Record_ID}:${f.Proposal_Type}`);
    }
    offset = data.offset;
  } while (offset);

  return pending;
}

interface ProposalRecord {
  fields: Record<string, unknown>;
}

async function batchCreateProposals(
  tableId: string,
  records: ProposalRecord[]
): Promise<number> {
  let created = 0;
  for (let i = 0; i < records.length; i += AIRTABLE_BATCH_SIZE) {
    const batch = records.slice(i, i + AIRTABLE_BATCH_SIZE);
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${tableId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AIRTABLE_PAT}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: batch, typecast: true }),
      }
    );
    if (res.ok) created += batch.length;
    else console.error("[Jarvis] Batch create failed:", await res.text());
  }
  return created;
}

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const proposalsTableId = getProposalsTableId();
  if (!proposalsTableId) {
    return Response.json(
      { error: "AGENT_PROPOSALS_TABLE_ID not set" },
      { status: 500 }
    );
  }

  if (!process.env.QUO_API_KEY) {
    return Response.json(
      { error: "QUO_API_KEY not set" },
      { status: 500 }
    );
  }

  try {
    const listings = await getListings();

    // Only check actionable listings that have agent phones
    const ACTIONABLE = new Set([
      "Negotiating",
      "Response Received",
      "Offer Accepted",
      "Texted",
    ]);
    const actionableListings = listings.filter(
      (l) => l.agentPhone && ACTIONABLE.has(l.outreachStatus ?? "")
    );

    // Dedupe phones — multiple listings can share an agent phone
    const phoneToListings = new Map<string, typeof actionableListings>();
    for (const listing of actionableListings) {
      const e164 = toE164(listing.agentPhone!);
      const existing = phoneToListings.get(e164) ?? [];
      existing.push(listing);
      phoneToListings.set(e164, existing);
    }

    // Cap phones per run to stay within timeout
    const phones = Array.from(phoneToListings.keys()).slice(
      0,
      MAX_PHONES_PER_RUN
    );

    // Pre-flight dedupe
    const existingPending =
      await fetchExistingPendingProposals(proposalsTableId);

    let phonesChecked = 0;
    let inboundFound = 0;
    let matched = 0;
    const newProposals: ProposalRecord[] = [];
    // 2026-06-08: was string[]. Now carries the INBOUND's actual createdAt,
    // not wall-clock now — the prior shape stamped Last_Inbound_At with
    // "right now" on every cron tick (line 278 used new Date()), so the
    // timestamp was always wrong by however long since the agent replied.
    // This breaks the conversation-check classifier (inbounds AFTER an
    // outbound look like they happened after a future outbound).
    const timestampUpdates: Array<{ id: string; inboundCreatedAt: string }> = [];
    const errors: string[] = [];

    for (const phone of phones) {
      phonesChecked++;
      try {
        const messages = await getMessagesForParticipant(
          phone,
          SCAN_WINDOW_MINUTES
        );

        // Find the most recent inbound message
        const inbound = messages.find((m) => m.direction === "incoming");
        if (!inbound) continue;
        inboundFound++;

        // Match to all listings with this phone
        const matchedListings = phoneToListings.get(phone) ?? [];
        for (const listing of matchedListings) {
          matched++;

          if (existingPending.has(`${listing.id}:jarvis_reply`)) continue;

          // INV — stamp the INBOUND's actual createdAt, not wall-clock now.
          // (Was the source of the unbacked-reply pattern + breaks
          // conversation-check's outbound-vs-inbound ordering.)
          timestampUpdates.push({ id: listing.id, inboundCreatedAt: inbound.createdAt });

          const draftResponse = await generateDraftResponse(
            listing,
            inbound.body
          );

          const actionPayload = JSON.stringify({
            recordId: listing.id,
            action: "send_sms",
            to: phone,
            draftBody: draftResponse,
            inboundBody: inbound.body,
          });

          newProposals.push({
            fields: {
              Proposal_ID: `jarvis_reply-${Date.now()}-${newProposals.length}`,
              Proposal_Type: "jarvis_reply",
              Priority: "HIGH",
              Record_ID: listing.id,
              Record_Address: listing.address,
              Reasoning: `Inbound from ${listing.agentName || "agent"}: "${inbound.body.slice(0, 200)}"`,
              Suggested_Action_Payload: actionPayload,
              Status: "Pending",
            },
          });

          existingPending.add(`${listing.id}:jarvis_reply`);
        }
      } catch (err) {
        errors.push(`${phone}: ${String(err)}`);
      }
    }

    // Batch create proposals
    const created =
      newProposals.length > 0
        ? await batchCreateProposals(proposalsTableId, newProposals)
        : 0;

    // Stamp Last_Inbound_At with the inbound's ACTUAL createdAt — was
    // wall-clock new Date() before 2026-06-08, breaking timeline ordering.
    for (const { id, inboundCreatedAt } of timestampUpdates) {
      try {
        await updateListingRecord(id, {
          fld3IhR1DXzcVuq6F: inboundCreatedAt,
        });
      } catch (err) {
        console.error(
          `[Jarvis] Failed to stamp Last_Inbound_At on ${id}:`,
          err
        );
      }
    }

    return Response.json({
      phonesInPool: phoneToListings.size,
      phonesChecked,
      inboundFound,
      matched,
      proposalsCreated: created,
      skippedDedupe: matched - newProposals.length,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[scan-comms] error:", err);
    return Response.json(
      { error: "Scan failed", detail: String(err) },
      { status: 500 }
    );
  }
}
