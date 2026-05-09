import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { buildJarvisSystemPrompt, computeJarvisScore } from "@/lib/jarvis-system-prompt";
import type {
  AgentContext,
  BroCard,
  CardType,
  DealContext,
  JarvisBrief,
  TimelineEntry,
} from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 60;

const ACTIVE_STATUSES = new Set(["Negotiating", "Response Received", "Offer Accepted"]);
const MAX_BROCARDS = 3;
const MAX_RANKED_FOR_LLM = 5;

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";

interface RankedDeal {
  context: DealContext;
  score: number;
  outreachStatus: string | null;
  agentContext: AgentContext | null;
}

function originFromReq(req: Request): string {
  // Prefer the request's own origin so we work in dev + Vercel previews.
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

async function fetchDealContext(origin: string, recordId: string, cookie: string | null): Promise<DealContext | null> {
  try {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${origin}/api/deal-context/${recordId}`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as DealContext | { error: string };
    if ("error" in data) return null;
    return data;
  } catch {
    return null;
  }
}

async function fetchAgentContext(origin: string, identifier: string, cookie: string | null): Promise<AgentContext | null> {
  try {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${origin}/api/agent-context/${encodeURIComponent(identifier)}`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as AgentContext | { error: string };
    if ("error" in data) return null;
    return data;
  } catch {
    return null;
  }
}

function summarizeTimeline(timeline: TimelineEntry[], limit = 8): string {
  return timeline
    .slice(-limit)
    .map((e) => {
      const ts = e.timestamp ? new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 16) : "—";
      const dir = e.direction === "in" ? "AGENT" : "ALEX";
      const ch = e.channel.toUpperCase();
      return `[${ts}] ${dir} (${ch}): ${e.body.slice(0, 220).replace(/\n+/g, " ")}`;
    })
    .join("\n");
}

function fallbackBroCard(deal: RankedDeal, rank: number): BroCard {
  const ctx = deal.context;
  const headline = deal.outreachStatus === "Offer Accepted"
    ? "Offer accepted — send PA"
    : ctx.responseDue
      ? `Agent waiting${ctx.hoursSinceInbound !== null ? ` ${ctx.hoursSinceInbound}h` : ""} — reply now`
      : "Re-engage stale negotiation";

  const cardType: CardType = deal.outreachStatus === "Offer Accepted"
    ? "OFFER_ACCEPTED_PA_NEEDED"
    : ctx.responseDue
      ? "NEGOTIATION_RESPONSE_DUE"
      : "STALE_REENGAGEMENT";

  return {
    rank,
    recordId: ctx.recordId,
    card_type: cardType,
    address: ctx.property.address,
    agent: ctx.agent.name ?? "—",
    headline,
    summary: `Last inbound ${ctx.hoursSinceInbound !== null ? `${ctx.hoursSinceInbound}h ago` : "unknown"}. Status: ${deal.outreachStatus ?? "—"}.`,
    why_this_matters: "Auto-generated fallback — Anthropic call did not return a parseable card.",
    score: deal.score,
    options: [
      { label: "Open Workspace", channel: "none", action_type: "clarify" },
    ],
    recommendation_index: 0,
    agentContext: deal.agentContext ?? undefined,
    metadata: { fallback: true },
  };
}

function coerceCardType(raw: unknown): CardType {
  const allowed: CardType[] = [
    "NEGOTIATION_RESPONSE_DUE",
    "OFFER_ACCEPTED_PA_NEEDED",
    "STALE_REENGAGEMENT",
    "AMBIGUOUS_NEEDS_REVIEW",
    "UNANSWERED_INBOUND_BLOCKING",
  ];
  if (typeof raw === "string" && (allowed as string[]).includes(raw)) return raw as CardType;
  return "STALE_REENGAGEMENT";
}

function safeStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function safeNum(v: unknown, fallback = 0): number {
  return typeof v === "number" && !isNaN(v) ? v : fallback;
}

function parseLLMCards(raw: string, ranked: RankedDeal[]): BroCard[] {
  let parsed: unknown;
  try {
    // Strip ```json fences if present.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return ranked.slice(0, MAX_BROCARDS).map((d, i) => fallbackBroCard(d, i + 1));
  }
  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { cards?: unknown }).cards)
      ? ((parsed as { cards: unknown[] }).cards)
      : [];
  if (arr.length === 0) {
    return ranked.slice(0, MAX_BROCARDS).map((d, i) => fallbackBroCard(d, i + 1));
  }

  const byRecord = new Map(ranked.map((r) => [r.context.recordId, r]));
  const cards: BroCard[] = [];
  for (let i = 0; i < arr.length && cards.length < MAX_BROCARDS; i++) {
    const obj = arr[i] as Record<string, unknown>;
    const recordId = safeStr(obj.recordId);
    const deal = byRecord.get(recordId) ?? ranked[i];
    if (!deal) continue;
    const optionsRaw = Array.isArray(obj.options) ? (obj.options as Record<string, unknown>[]) : [];
    const options = optionsRaw.map((o) => ({
      label: safeStr(o.label, "Action"),
      channel: ((): "sms" | "email" | "none" => {
        const c = safeStr(o.channel);
        return c === "sms" || c === "email" || c === "none" ? c : "none";
      })(),
      action_type: ((): BroCard["options"][number]["action_type"] => {
        const t = safeStr(o.action_type);
        const allowed = ["send_reply", "mark_dead", "walk", "clarify", "accept", "counter"];
        return allowed.includes(t) ? (t as BroCard["options"][number]["action_type"]) : "clarify";
      })(),
      draft: typeof o.draft === "string" ? o.draft : undefined,
      subject: typeof o.subject === "string" ? o.subject : undefined,
    }));
    cards.push({
      rank: cards.length + 1,
      recordId: deal.context.recordId,
      card_type: coerceCardType(obj.card_type),
      address: safeStr(obj.address, deal.context.property.address),
      agent: safeStr(obj.agent, deal.context.agent.name ?? "—"),
      headline: safeStr(obj.headline, "Action needed"),
      summary: safeStr(obj.summary, ""),
      why_this_matters: safeStr(obj.why_this_matters, ""),
      score: safeNum(obj.score, deal.score),
      options: options.length > 0 ? options : [{ label: "Open Workspace", channel: "none", action_type: "clarify" }],
      recommendation_index: Math.min(
        Math.max(0, Math.floor(safeNum(obj.recommendation_index, 0))),
        Math.max(0, options.length - 1),
      ),
      agentContext: deal.agentContext ?? undefined,
      metadata: typeof obj.metadata === "object" && obj.metadata !== null ? (obj.metadata as Record<string, unknown>) : {},
    });
  }
  return cards;
}

export async function GET(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 500 },
    );
  }

  try {
    const allListings = await getListings();
    const active = allListings.filter((l) => ACTIVE_STATUSES.has(l.outreachStatus ?? ""));

    const origin = originFromReq(req);
    const cookie = req.headers.get("cookie");

    // Pull deal-context for each active listing in parallel (capped to a sane limit).
    const candidatePool = active.slice(0, 30);
    const contexts = await Promise.all(
      candidatePool.map((l) => fetchDealContext(origin, l.id, cookie).then((ctx) => ({ listing: l, ctx }))),
    );

    const ranked: RankedDeal[] = contexts
      .filter((x): x is { listing: typeof x.listing; ctx: DealContext } => Boolean(x.ctx))
      .map((x) => {
        const status = x.listing.outreachStatus;
        const score = computeJarvisScore({
          hoursSinceInbound: x.ctx.hoursSinceInbound,
          lastInboundBody: (x.ctx.metadata?.lastInboundBody as string) ?? null,
          outreachStatus: status,
          multiListingAlert: x.ctx.multiListingAlert,
        });
        return { context: x.ctx, score, outreachStatus: status, agentContext: null };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RANKED_FOR_LLM);

    // Hydrate agentContext for the top-N.
    await Promise.all(
      ranked.map(async (r) => {
        const id = r.context.agent.phone ?? r.context.agent.email;
        if (!id) return;
        r.agentContext = await fetchAgentContext(origin, id, cookie);
      }),
    );

    if (ranked.length === 0) {
      const empty: JarvisBrief = {
        broCards: [],
        ambiguousQueue: [],
        metadata: {
          generated_at: new Date().toISOString(),
          model: ANTHROPIC_MODEL,
          total_active_deals: active.length,
        },
      };
      return NextResponse.json(empty);
    }

    const system = buildJarvisSystemPrompt({
      context: "brief",
      includeDepthAwareDrafting: true,
    });

    const dealBlocks = ranked.map((r, i) => {
      const ctx = r.context;
      const ac = r.agentContext;
      const lastInBody = (ctx.metadata?.lastInboundBody as string) ?? "—";
      return `### DEAL ${i + 1} — ${ctx.property.address}
recordId: ${ctx.recordId}
agent: ${ctx.agent.name ?? "—"} (phone: ${ctx.agent.phone ?? "—"}, email: ${ctx.agent.email ?? "—"})
outreachStatus: ${r.outreachStatus ?? "—"}
listPrice: ${ctx.property.listPrice ?? "—"}
hoursSinceInbound: ${ctx.hoursSinceInbound ?? "—"}
hoursSinceOutbound: ${ctx.hoursSinceOutbound ?? "—"}
responseDue: ${ctx.responseDue}
multiListingAlert: ${ctx.multiListingAlert}${ac ? `\nagentContext: depthScore=${ac.depthScore} totalListings=${ac.totalListings} totalReplies=${ac.totalReplies} inferredTone=${ac.inferredTone} unanswered=${ac.propertiesWithUnansweredInbound.length} active=${ac.activeProperties.length}` : ""}
lastInboundBody: ${lastInBody.slice(0, 200)}
recent timeline:
${summarizeTimeline(ctx.timeline)}
score: ${r.score}`;
    }).join("\n\n");

    const userPrompt = `Here are the top ${ranked.length} active deals ranked by Jarvis score. Pick the top ${MAX_BROCARDS} that need Alex's attention NOW and emit BroCards.

${dealBlocks}

Output ONLY a JSON array (no prose, no markdown fences). Each element must be a BroCard:
{
  "rank": 1,
  "recordId": "rec...",
  "card_type": "NEGOTIATION_RESPONSE_DUE" | "OFFER_ACCEPTED_PA_NEEDED" | "STALE_REENGAGEMENT" | "AMBIGUOUS_NEEDS_REVIEW" | "UNANSWERED_INBOUND_BLOCKING",
  "address": "...",
  "agent": "...",
  "headline": "Single tight phrase, <=8 words",
  "summary": "<=2 sentences. Reference dollar figures and dates if present.",
  "why_this_matters": "Why this is urgent. Reference depth score / multi-listing / responseDue.",
  "score": <number>,
  "options": [
    { "label": "Send reply", "channel": "sms"|"email"|"none", "action_type": "send_reply"|"mark_dead"|"walk"|"clarify"|"accept"|"counter", "draft": "ready-to-send body honoring depth-aware drafting rules", "subject": "(optional, only for email)" }
  ],
  "recommendation_index": 0,
  "metadata": {}
}

For depthScore >= 1: NEVER write "this is Alex with AKB Solutions" in any draft. Drop the introduction.
For depthScore == 3: be conversational; treat the agent as a colleague.
If propertiesWithUnansweredInbound (per agentContext) is non-empty, prefer card_type="UNANSWERED_INBOUND_BLOCKING" and recommend responding on those threads first.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    let cards: BroCard[];
    if (!res.ok) {
      console.error(`[jarvis-brief] Anthropic ${res.status}:`, await res.text().catch(() => ""));
      cards = ranked.slice(0, MAX_BROCARDS).map((d, i) => fallbackBroCard(d, i + 1));
    } else {
      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = data.content?.find((b) => b.type === "text")?.text ?? "";
      cards = parseLLMCards(text, ranked);
    }

    // Ensure agentContext is present on every card (LLM may drop it).
    cards = cards.map((c) => {
      if (c.agentContext) return c;
      const r = ranked.find((x) => x.context.recordId === c.recordId);
      return r?.agentContext ? { ...c, agentContext: r.agentContext } : c;
    });

    const ambiguousQueue = ranked
      .filter((r) => r.context.ambiguousMessages.length > 0)
      .map((r) => ({
        recordId: r.context.recordId,
        address: r.context.property.address,
        ambiguousMessages: r.context.ambiguousMessages,
      }));

    const brief: JarvisBrief = {
      broCards: cards,
      ambiguousQueue,
      metadata: {
        generated_at: new Date().toISOString(),
        model: ANTHROPIC_MODEL,
        total_active_deals: active.length,
      },
    };

    return NextResponse.json(brief);
  } catch (err) {
    console.error("[jarvis-brief] error:", err);
    return NextResponse.json(
      { error: "Failed to build brief", detail: String(err) },
      { status: 500 },
    );
  }
}
