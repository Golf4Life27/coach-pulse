// @deprecated Legacy chat backend. Maverick MCP server
// (`app/api/maverick/mcp/route.ts`) handles the same role with
// OAuth-authenticated access + named-agent attribution. Phase 9.11
// deprecation tag; URL kept live until the Shepherd panel's chat
// surface (Phase 9.1) routes through MCP instead.

import { getListings, getListing, getDeals } from "@/lib/airtable";
import { buildActionQueue } from "@/lib/actionQueue";
import { synthesize, type SynthesizeMessage } from "@/lib/maverick/synthesizer";
import { extractStickyOffer } from "@/lib/h2-outreach/bump-lane";

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

const SYSTEM_PROMPT = `You are Maverick, the AI operations co-pilot for AKB Solutions' wholesale cockpit.

Alex is asking you a question — sometimes about the whole pipeline, sometimes about the specific deal on his screen (its context block is injected when present).

## PRICING DOCTRINE (HOLD, never improvise — operator rulings 2026-06-28 / 2026-07-01)
- The value-anchored formula is the ONLY producer of offer numbers: anchor × (ARV × buy-box − rehab − fee). The flat 65%-of-list rule is RETIRED — never compute, suggest, or sanity-check a price as a fraction of list.
- You NEVER invent a number. Cite only numbers present in the injected context: the DELIVERY-STAMPED offer (the number the agent's phone received — stamps outrank fields, which drift), the underwritten MAO ceiling, ARV/rehab bands with their confidence. If a number you need is absent, say exactly which producer must run (Appraiser ARV / rehab vision / underwrite) — that IS the correct answer.
- The two-lane MAO (landlord / flipper) is the negotiation CEILING. Never suggest a number above the ceiling; never suggest re-anchoring to the seller's list price.
- Sticky offers: the seller-facing number never drifts. If Alex already stated or sent a number, do not propose a different one unless he asks to re-price — then route to the pricer, don't compute inline.

## BUSINESS RULES
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

/** On-screen record context (cockpit dock): the deal Alex is LOOKING AT.
 *  Sourced numbers only — the stamped offer, the ceiling, the bands with
 *  their confidence. The model is instructed to cite these and nothing
 *  else. */
async function buildRecordContext(recordId: string): Promise<string | null> {
  const listing = await getListing(recordId).catch(() => null);
  if (!listing) return null;
  const stamped = extractStickyOffer(listing.notes)?.offer ?? null;
  const money = (n: number | null | undefined) => (n == null ? "— (not produced)" : formatCurrency(n));
  return [
    "## THE DEAL ON ALEX'S SCREEN (cite ONLY these numbers)",
    `Address: ${listing.address}${listing.city ? `, ${listing.city}` : ""}${listing.state ? `, ${listing.state}` : ""}`,
    `Status: ${listing.outreachStatus ?? "—"} · Live: ${listing.liveStatus ?? "—"} · DOM ${listing.dom ?? "—"}`,
    `List price: ${money(listing.listPrice)}`,
    `DELIVERY-STAMPED offer (the number the agent received): ${stamped == null ? "NONE — no [H2 sent] stamp on record" : formatCurrency(stamped)}`,
    `Ceiling (underwritten MAO): ${money(listing.underwrittenMao ?? listing.mao)}`,
    `ARV: ${money(listing.realArvMedian)} (confidence ${listing.arvConfidence ?? "—"}, comps ${listing.arvCompCount ?? "—"})`,
    `Rehab band: mid ${money(listing.estRehabMid)} (confidence ${listing.rehabConfidenceScore ?? "—"})`,
    `Last inbound: ${listing.lastInboundAt ?? "never"} · Last outbound: ${listing.lastOutboundAt ?? "never"}`,
    `Agent: ${listing.agentName ?? "—"}${listing.doNotText ? " · DO NOT TEXT" : ""}`,
  ].join("\n");
}

export async function POST(req: Request) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 }
    );
  }

  let body: { messages: ChatMessage[]; recordId?: string };
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
    // Record-scoped chat (the dock on a deal room): focused context, no
    // full-pipeline scan — fast, and the model can only cite this deal's
    // sourced numbers. Falls through to the pipeline-wide summary when the
    // record can't be loaded.
    let contextSummary: string | null = null;
    if (body.recordId && /^rec[A-Za-z0-9]{14}$/.test(body.recordId)) {
      contextSummary = await buildRecordContext(body.recordId);
    }

    if (contextSummary == null) {
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
      contextSummary = buildContextSummary(queue, pendingCount);
    }

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

    // Phase 10 / P.2 migration — multi-turn via synthesizer.
    try {
      const result = await synthesize({
        agent: "maverick",
        system: SYSTEM_PROMPT,
        messages: messages as SynthesizeMessage[],
        max_tokens: 1000,
        event_label: "maverick_chat_synthesized",
      });
      const answer = result.text || "[No response generated]";
      return Response.json({ answer });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const statusMatch = msg.match(/^Anthropic (\d+):/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 502;
      return Response.json(
        { error: `Anthropic error: ${status}`, detail: msg },
        { status: 502 }
      );
    }
  } catch (err) {
    console.error("[jarvis-chat] error:", err);
    return Response.json(
      { error: "Jarvis failed", detail: String(err) },
      { status: 500 }
    );
  }
}
