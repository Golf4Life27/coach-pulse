import { getListings, updateListingRecord } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";

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

function toE164(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Jarvis] Anthropic error:", res.status, errText);
      return "[Draft generation failed]";
    }

    const data = await res.json();
    const blocks = data.content as Array<{ type: string; text?: string }>;
    const textBlock = blocks?.find((b) => b.type === "text");
    return textBlock?.text || "[Draft generation failed]";
  } catch (err) {
    console.error("[Jarvis] AI draft error:", err);
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
    const timestampUpdates: string[] = [];
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

          timestampUpdates.push(listing.id);

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

    // Update Last_Inbound_At on matched listings
    for (const id of timestampUpdates) {
      try {
        await updateListingRecord(id, {
          fld3IhR1DXzcVuq6F: new Date().toISOString(),
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
