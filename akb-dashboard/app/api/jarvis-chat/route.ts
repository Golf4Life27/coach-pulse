// @deprecated Legacy chat backend. Maverick MCP server
// (`app/api/maverick/mcp/route.ts`) handles the same role with
// OAuth-authenticated access + named-agent attribution. Phase 9.11
// deprecation tag; URL kept live until the Shepherd panel's chat
// surface (Phase 9.1) routes through MCP instead.

import { getListings, getDeals } from "@/lib/airtable";
import { buildActionQueue } from "@/lib/actionQueue";

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

function getProposalsTableId(): string | null {
  return process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
}

const DEAD_STATUSES = new Set(["Dead", "Walked", "Terminated", "No Response"]);

async function fetchPendingProposalCount(): Promise<number> {
  const tableId = getProposalsTableId();
  if (!tableId) return 0;
  try {
    const params = new URLSearchParams();
    params.set("filterByFormula", '{Status}="Pending"');
    params.set("fields[]", "Proposal_ID");
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${tableId}?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
        cache: "no-store",
      }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return data.records?.length ?? 0;
  } catch {
    return 0;
  }
}

function formatCurrency(n: number | null | undefined): string {
  if (n == null) return "—";
  return "$" + Math.round(n).toLocaleString("en-US");
}

function buildContextSummary(
  queue: ReturnType<typeof buildActionQueue>,
  pendingProposals: number
): string {
  // Only include Open cards — exclude Held and Cleared
  const open = queue.open;
  const responses = open.filter((c) => c.kind === "response");
  const deals = open.filter((c) => c.kind === "deal");
  const stale = open.filter((c) => c.kind === "stale");
  const dd = open.filter((c) => c.kind === "dd");

  const lines = [
    "## CURRENT DASHBOARD STATE",
    `Open cards: ${open.length} (${responses.length} responses, ${deals.length} deals, ${dd.length} DD, ${stale.length} stale)`,
    `Held cards: ${queue.held.length}`,
    `Pending Jarvis proposals: ${pendingProposals}`,
    "",
  ];

  if (responses.length > 0) {
    lines.push("## RESPONSE CARDS (agents replied — highest priority)");
    for (const c of responses) {
      if (c.kind !== "response") continue;
      const loc = [c.city, c.state].filter(Boolean).join(", ");
      lines.push(
        `- ${c.address}${loc ? `, ${loc}` : ""}: Agent ${c.agentName ?? "—"}, List ${formatCurrency(c.listPrice)}, MAO ${formatCurrency(c.mao)}, DOM ${c.dom ?? "—"}. They said: "${(c.inboundMessage ?? "").slice(0, 150)}"`
      );
    }
    lines.push("");
  }

  if (deals.length > 0) {
    lines.push("## DEAL CARDS (under contract or closing)");
    for (const c of deals) {
      if (c.kind !== "deal") continue;
      const loc = [c.city, c.state].filter(Boolean).join(", ");
      lines.push(
        `- ${c.address}${loc ? `, ${loc}` : ""}: Contract ${formatCurrency(c.contractPrice)}, Assignment ${formatCurrency(c.assignmentPrice)}, Spread ${formatCurrency(c.spread)}, Status: ${c.closingStatus ?? c.status ?? "—"}`
      );
    }
    lines.push("");
  }

  if (dd.length > 0) {
    lines.push("## DD CARDS (due diligence incomplete)");
    for (const c of dd) {
      if (c.kind !== "dd") continue;
      const loc = [c.city, c.state].filter(Boolean).join(", ");
      lines.push(
        `- ${c.address}${loc ? `, ${loc}` : ""}: Agent ${c.agentName ?? "—"}, Missing: ${c.missingItems.join(", ")}`
      );
    }
    lines.push("");
  }

  if (stale.length > 0) {
    lines.push("## STALE CARDS (need follow-up)");
    for (const c of stale.slice(0, 15)) {
      if (c.kind !== "stale") continue;
      const loc = [c.city, c.state].filter(Boolean).join(", ");
      lines.push(
        `- ${c.address}${loc ? `, ${loc}` : ""}: ${c.daysSilent} days silent, Agent ${c.agentName ?? "—"}, Last outreach: ${c.lastOutreachDate?.slice(0, 10) ?? "never"}`
      );
    }
    if (stale.length > 15) lines.push(`  ... and ${stale.length - 15} more`);
    lines.push("");
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are Jarvis, the AI operations assistant for AKB Solutions' wholesale pipeline dashboard.

Alex is asking you what to focus on right now. You have full visibility into the action queue, pending deals, and stale leads.

## BUSINESS RULES
- Offers are 65% of list price, rounded up to nearest $250. Never use AVM, ARV, or estimates.
- Never use "assignable" — say "affiliated entity"
- Never disclose contract price, ARV, or repairs to buyers. Buyers see Assignment Price only.
- DD checklist must be complete before contracting.

## CRITICAL RULES
- Never recommend sending an offer or PA if Outreach_Status is "Dead", "Walked", "Terminated", or "No Response".
- Never recommend changing a price that the operator has already stated. If Notes show the operator held firm at a price, do not suggest a different number.
- Never recommend new outreach on Memphis (TN) deals — Memphis acquisitions are PAUSED as of 4/26/2026 due to non-assignability clauses in brokerage contracts. Exception: deals already under contract. If a TN agent responds positively, flag that Memphis is paused and Alex needs to decide if this specific deal is worth pursuing despite the assignment clause risk.
- If a deal shows a formal offer was already emailed (Notes contain "formal offer" or "purchase agreement" or "PA sent"), do not recommend sending another one — instead recommend following up on the existing offer.
- If a listing has Do_Not_Text flagged, never recommend sending a text to that agent. Email or other contact methods only.
- If outreach was sent today, do not recommend re-sending. If 3+ days ago, recommend follow-up.
- Always show city and state with each property address.

## RESPONSE FORMAT
Structure your response in these sections:

## CONTRACTS READY (agents who said yes — send purchase agreements NOW)
## ACTIVE NEGOTIATIONS (counters, pricing discussions — need a decision)
## FOLLOW-UPS NEEDED (stale conversations — need a nudge)
## NEW RESPONSES (agents replied but situation unclear — need review)

Only include categories that have items. If nothing is urgent, say "Pipeline is clean — no immediate actions needed" and suggest proactive moves like running new PropStream exports or following up on pending contracts.

## STYLE
- Be direct and actionable. Number your recommendations.
- Lead with the highest-ROI action (biggest spread, hottest lead, or most time-sensitive)
- Reference specific properties by address, city/state, and agent name
- If an agent replied, that's always top priority
- Keep it under 200 words unless asked to elaborate
- Use casual but professional tone — you're Alex's operations co-pilot`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(req: Request) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 }
    );
  }

  let body: { messages: ChatMessage[] };
  try {
    const text = await req.text();
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: "Missing messages array" }, { status: 400 });
  }

  try {
    const [allListings, deals, pendingCount] = await Promise.all([
      getListings(),
      getDeals(),
      fetchPendingProposalCount(),
    ]);

    // Filter out dead/walked/terminated listings before building queue
    const listings = allListings.filter(
      (l) =>
        !DEAD_STATUSES.has(l.outreachStatus ?? "") &&
        l.actionCardState !== "Cleared"
    );

    const queue = buildActionQueue(listings, deals);
    const contextSummary = buildContextSummary(queue, pendingCount);

    // Inject context into the first user message
    const messages = body.messages.map((m, i) => {
      if (i === 0 && m.role === "user") {
        return {
          role: m.role,
          content: `${contextSummary}\n\n---\n\nAlex says: ${m.content}`,
        };
      }
      return m;
    });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return Response.json(
        { error: `Anthropic error: ${res.status}`, detail: errText },
        { status: 502 }
      );
    }

    const data = await res.json();
    const blocks = data.content as Array<{ type: string; text?: string }>;
    const textBlock = blocks?.find((b) => b.type === "text");
    const answer = textBlock?.text ?? "[No response generated]";

    return Response.json({ answer });
  } catch (err) {
    console.error("[jarvis-chat] error:", err);
    return Response.json(
      { error: "Jarvis failed", detail: String(err) },
      { status: 500 }
    );
  }
}
