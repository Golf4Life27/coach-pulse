import { getListings, getDeals } from "@/lib/airtable";
import { buildActionQueue } from "@/lib/actionQueue";

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

function getProposalsTableId(): string | null {
  return process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
}

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
  const { open, held } = queue;
  const responses = open.filter((c) => c.kind === "response");
  const deals = open.filter((c) => c.kind === "deal");
  const stale = open.filter((c) => c.kind === "stale");
  const dd = open.filter((c) => c.kind === "dd");

  const lines = [
    "## CURRENT DASHBOARD STATE",
    `Open cards: ${open.length} (${responses.length} responses, ${deals.length} deals, ${dd.length} DD, ${stale.length} stale)`,
    `Held cards: ${held.length}`,
    `Pending Jarvis proposals: ${pendingProposals}`,
    "",
  ];

  if (responses.length > 0) {
    lines.push("## RESPONSE CARDS (agents replied — highest priority)");
    for (const c of responses) {
      if (c.kind !== "response") continue;
      lines.push(
        `- ${c.address}${c.city ? `, ${c.city}` : ""}${c.state ? `, ${c.state}` : ""}: Agent ${c.agentName ?? "—"}, List ${formatCurrency(c.listPrice)}, MAO ${formatCurrency(c.mao)}. They said: "${(c.inboundMessage ?? "").slice(0, 100)}"`
      );
    }
    lines.push("");
  }

  if (deals.length > 0) {
    lines.push("## DEAL CARDS");
    for (const c of deals) {
      if (c.kind !== "deal") continue;
      lines.push(
        `- ${c.address}: Contract ${formatCurrency(c.contractPrice)}, Assignment ${formatCurrency(c.assignmentPrice)}, Spread ${formatCurrency(c.spread)}, Status: ${c.closingStatus ?? c.status ?? "—"}`
      );
    }
    lines.push("");
  }

  if (stale.length > 0) {
    lines.push("## STALE CARDS (need follow-up)");
    for (const c of stale.slice(0, 10)) {
      if (c.kind !== "stale") continue;
      lines.push(`- ${c.address}: ${c.daysSilent} days silent, Agent ${c.agentName ?? "—"}`);
    }
    if (stale.length > 10) lines.push(`  ... and ${stale.length - 10} more`);
    lines.push("");
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are Jarvis, the AI operations assistant for AKB Solutions' wholesale pipeline dashboard.

Alex is asking you what to focus on right now. You have full visibility into the action queue, pending deals, and stale leads.

BUSINESS RULES:
- Offers are 65% of list price, rounded up to nearest $250
- Never use "assignable" — say "affiliated entity"
- Never disclose contract price, ARV, or repairs to buyers
- DD checklist must be complete before contracting

RESPONSE STYLE:
- Be direct and actionable. Number your recommendations.
- Lead with the highest-ROI action (biggest spread, hottest lead, or most time-sensitive)
- Reference specific properties by address and agent name
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
    const [listings, deals, pendingCount] = await Promise.all([
      getListings(),
      getDeals(),
      fetchPendingProposalCount(),
    ]);

    const queue = buildActionQueue(listings, deals);
    const contextSummary = buildContextSummary(queue, pendingCount);

    // Inject context into the first user message
    const messages = body.messages.map((m, i) => {
      if (i === 0 && m.role === "user") {
        return { role: m.role, content: `${contextSummary}\n\n---\n\nAlex says: ${m.content}` };
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
