import Anthropic from "@anthropic-ai/sdk";
import { getListing } from "@/lib/airtable";
import { parseConversation } from "@/lib/notes";
import { ALL_DD_ITEMS } from "@/lib/actionQueue";

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";
const DEALS_TABLE = "tblKDYhaghKe6dToW";

const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  let timestamps = rateLimitMap.get(key) ?? [];
  timestamps = timestamps.filter((t) => now - t < 60_000);
  if (timestamps.length >= 10) return false;
  timestamps.push(now);
  rateLimitMap.set(key, timestamps);
  return true;
}

async function fetchSummaryData(): Promise<string> {
  const headers = { Authorization: `Bearer ${AIRTABLE_PAT}` };

  const [listingsRes, dealsRes] = await Promise.all([
    fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}?fields[]=fldwvp72hKTfiHHjj&fields[]=fldGIgqwyCJg4uFyv&fields[]=fld9J3Vi9fTq3zzMU&fields[]=fld69oB0no6tfguom&fields[]=fldCKnC1nnXEnTUKL&returnFieldsByFieldId=true`,
      { headers, cache: "no-store" }
    ),
    fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${DEALS_TABLE}?returnFieldsByFieldId=true`,
      { headers, cache: "no-store" }
    ),
  ]);

  const listingsData = listingsRes.ok ? await listingsRes.json() : { records: [] };
  const dealsData = dealsRes.ok ? await dealsRes.json() : { records: [] };

  const listings = listingsData.records.map((r: Record<string, unknown>) => {
    const f = (r as { fields: Record<string, unknown> }).fields;
    return {
      id: (r as { id: string }).id,
      address: f.fldwvp72hKTfiHHjj,
      outreachStatus: f.fldGIgqwyCJg4uFyv,
      listPrice: f.fld9J3Vi9fTq3zzMU,
      agentName: f.fld69oB0no6tfguom,
      liveStatus: f.fldCKnC1nnXEnTUKL,
    };
  });

  const deals = dealsData.records.map((r: Record<string, unknown>) => {
    const f = (r as { fields: Record<string, unknown> }).fields;
    return {
      id: (r as { id: string }).id,
      address: f.fld2AaqbSahBMY62j,
      contractPrice: f.fldGZO10DHc9evl0L,
      offerPrice: f.fldnxxzcMRzL1j1hJ,
      assignmentFee: f.flddXvwvKdx47Xa9X,
      closingStatus: f.fldTvNokAK5AEqz9z,
    };
  });

  return JSON.stringify({ listings: listings.slice(0, 100), deals });
}

function formatCurrency(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

async function buildPropertyContext(recordId: string): Promise<string | null> {
  const listing = await getListing(recordId);
  if (!listing) return null;

  const checked = new Set(listing.ddChecklist ?? []);
  const missing = ALL_DD_ITEMS.filter((i) => !checked.has(i));
  const ddLine = `${checked.size}/${ALL_DD_ITEMS.length} complete${
    missing.length ? ` (missing: ${missing.join(", ")})` : ""
  }`;

  const entries = parseConversation(listing.notes);
  const conversation = entries.length
    ? entries
        .map((e) => {
          const ts = e.timestamp ?? "—";
          const tag =
            e.type === "outbound"
              ? "OUTBOUND ALEX"
              : e.type === "inbound"
              ? "INBOUND"
              : "system";
          return `[${ts}] (${tag}) ${e.text}`;
        })
        .join("\n")
    : "(no conversation history yet)";

  return [
    "## FOCUSED PROPERTY",
    `Address: ${listing.address}${
      listing.city ? `, ${listing.city}` : ""
    }${listing.state ? `, ${listing.state}` : ""}${
      listing.zip ? ` ${listing.zip}` : ""
    }`,
    `Agent: ${listing.agentName ?? "—"}${
      listing.agentPhone ? ` (${listing.agentPhone})` : ""
    }`,
    `Outreach Status: ${listing.outreachStatus ?? "—"}`,
    `List Price: ${formatCurrency(listing.listPrice)}`,
    `MAO (65% rule): ${formatCurrency(listing.mao)}`,
    `DOM: ${listing.dom ?? "—"}`,
    `Last Outreach: ${listing.lastOutreachDate ?? "—"}`,
    `DD Checklist: ${ddLine}`,
    `Do_Not_Text: ${listing.doNotText ? "TRUE (outreach paused)" : "false"}`,
    "",
    "## CONVERSATION HISTORY (oldest → newest)",
    conversation,
  ].join("\n");
}

const SYSTEM_PROMPT = `You are the command interpreter and assistant for AKB Solutions' wholesale pipeline dashboard.

You receive a natural language command and must classify it as one of four intents, then return a structured JSON response.

## AKB SOLUTIONS — BUSINESS RULES (apply to every response)

OFFER FORMULA: All offers are 65% of the seller's list price, rounded up to the nearest $250. Never use AVM, ARV, or estimated values to derive an offer — only the 65% rule.

DD CHECKLIST (required before contracting):
1. Bed/Bath Verified
2. Vacancy Status Known
3. Roof Age Asked
4. HVAC Age Asked
5. Water Heater Age Asked
6. Showing Access Confirmed

NEVER DISCLOSE TO BUYERS:
- Contract Price
- ARV
- Estimated Repairs
Anything sent to a buyer must show ONLY the Assignment Price.

ENTITY FLEXIBILITY LANGUAGE: When discussing the closing entity with sellers or listing agents, use "We may close under one of our affiliated entities." Never use the word "assignable."

GEOGRAPHIC SCOPE: Memphis (TN) is PAUSED for new acquisitions. New outreach is TX only. TN deals already in motion can still close.

CANONICAL FIELD NAME: The status pipeline field is "Outreach_Status" (NOT "Pipeline_Status"). Statuses use the exact Airtable choice names: Not Contacted, Texted, Emailed, Response Received, Negotiating, Offer Accepted, Dead, Manual Review, Inbound Lead.

## INTENTS
1. "navigate" — user wants to go to a page or record. Return the dashboard route.
   Routes: / (ACT NOW), /pipeline, /deals, /buyers, /system
   If they reference a specific property, search the data for it and return the best route.

2. "action" — user wants to trigger a dashboard action. Currently supported:
   - "draft_followup" — draft a follow-up message for a Negotiating/Offer Accepted record. Return the recordId of the matching listing.

3. "query" — user is asking a question about their data, OR asking you to draft a message (counter offer, follow-up, DD questions, etc.) for a focused property. Read any FOCUSED PROPERTY context plus the listings/deals summary, compute or compose the answer, and return it as plain text in "answer". Apply the business rules above when drafting any seller- or agent-facing message.

4. "unclear" — you can't determine the intent. Return a clarifying question.

## DATA CONTEXT
The user message contains:
- An optional FOCUSED PROPERTY block with that property's fields and parsed conversation history. Use this when the user asks about "this property" or wants you to draft a reply.
- A JSON summary of the current Listings_V1 and Deals tables. Use this for queries that span the pipeline and to find records by address/agent name.

## RESPONSE FORMAT — return exactly this JSON
{
  "intent": "navigate" | "action" | "query" | "unclear",
  "route": "/pipeline" | null,
  "action_type": "draft_followup" | null,
  "action_payload": { "recordId": "recXXX" } | null,
  "answer": "text answer for query intent" | null,
  "clarification": "question for unclear intent" | null
}`;

interface CommandRequestBody {
  command?: string;
  propertyContext?: { recordId?: string };
}

export async function POST(req: Request) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 }
    );
  }

  if (!checkRateLimit("global")) {
    return Response.json(
      { error: "Rate limit: max 10 commands per minute" },
      { status: 429 }
    );
  }

  let body: CommandRequestBody;
  try {
    const text = await req.text();
    if (!text.trim()) {
      return Response.json({ error: "Empty body" }, { status: 400 });
    }
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { command, propertyContext } = body;
  if (!command || !command.trim()) {
    return Response.json({ error: "Missing command" }, { status: 400 });
  }

  let summaryData: string;
  try {
    summaryData = await fetchSummaryData();
  } catch (err) {
    console.error("[command] Failed to fetch summary data:", err);
    summaryData = '{"listings":[],"deals":[]}';
  }

  let propertyBlock: string | null = null;
  if (propertyContext?.recordId) {
    try {
      propertyBlock = await buildPropertyContext(propertyContext.recordId);
    } catch (err) {
      console.error("[command] Failed to load property context:", err);
      // Non-fatal — continue without the focused property block.
    }
  }

  const userMessage = [
    propertyBlock,
    `## COMMAND\n"${command}"`,
    `## DATA SUMMARY\n${summaryData}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      // System prompt is static across requests — cache it. The volatile
      // pieces (command, data summary, property context) live in the user
      // message, after the cached prefix, so they don't invalidate the cache.
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return Response.json(
        { error: "Claude returned no text" },
        { status: 502 }
      );
    }

    const raw = textBlock.text;
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      return Response.json(
        { error: "Claude returned unparseable output", raw },
        { status: 502 }
      );
    }

    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));

    logCommand(command, parsed).catch(() => {});

    return Response.json(parsed);
  } catch (err) {
    console.error("[command] Claude error:", err);
    return Response.json(
      { error: "Claude API call failed", detail: String(err) },
      { status: 500 }
    );
  }
}

async function logCommand(
  command: string,
  result: Record<string, unknown>
): Promise<void> {
  const COMMAND_LOG_TABLE = process.env.COMMAND_LOG_TABLE_ID;
  if (!COMMAND_LOG_TABLE) return;

  await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/${COMMAND_LOG_TABLE}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          Command_Text: command,
          Intent_Type: result.intent ?? "unclear",
          Result_Summary:
            (result.answer as string) ??
            (result.route as string) ??
            JSON.stringify(result),
          Success: result.intent !== "unclear",
        },
        typecast: true,
      }),
    }
  );
}
