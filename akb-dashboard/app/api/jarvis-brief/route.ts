import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { buildJarvisSystemPrompt, computeJarvisScore } from "@/lib/jarvis-system-prompt";
import { getVolleyText } from "@/lib/dd-volley";
import type {
  AgentContext,
  BroCard,
  CardType,
  DDStatus,
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
  ddStatus: DDStatus | null;
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

async function fetchDDStatus(origin: string, recordId: string, cookie: string | null): Promise<DDStatus | null> {
  try {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${origin}/api/dd-status/${recordId}`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as DDStatus;
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
    "PRE_OFFER_BLOCKED",
    "DD_BLOCKER",
    "DD_VOLLEY_TEXT_1_DUE",
    "DD_VOLLEY_TEXT_2_DUE",
    "DD_VOLLEY_TEXT_3_DUE",
    "DD_VOLLEY_COMPLETE",
    "BUYER_MATCH_READY",
    "BUYER_WARMUP_DUE",
    "BUYER_FORM_COMPLETED",
    "BUYER_BLAST_RECOMMENDED",
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
        const allowed = [
          "send_reply", "mark_dead", "walk", "clarify", "accept", "counter",
          "send_dd_volley_1", "send_dd_volley_2", "send_dd_volley_3",
          "fire_buyer_blast", "run_pre_offer_screen", "review_buyer_form",
        ];
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
        return { context: x.ctx, score, outreachStatus: status, agentContext: null, ddStatus: null };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RANKED_FOR_LLM);

    // Hydrate agentContext + ddStatus in parallel for the top-N.
    await Promise.all(
      ranked.map(async (r) => {
        const id = r.context.agent.phone ?? r.context.agent.email;
        const [ac, dd] = await Promise.all([
          id ? fetchAgentContext(origin, id, cookie) : Promise.resolve(null),
          fetchDDStatus(origin, r.context.recordId, cookie),
        ]);
        r.agentContext = ac;
        r.ddStatus = dd;
        // DD score bump per spec: incomplete DD on Negotiating/Offer Accepted
        // makes "send volley" the primary action and adds +50 to score.
        if (r.ddStatus && (r.ddStatus.recommendedActions[0]?.action ?? "").startsWith("send_volley_text_")) {
          r.score += 50;
        }
      }),
    );

    // Re-sort after the DD bumps so the LLM sees the most-urgent deals first.
    ranked.sort((a, b) => b.score - a.score);

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
      const dd = r.ddStatus;
      const lastInBody = (ctx.metadata?.lastInboundBody as string) ?? "—";
      const ddLine = dd ? `\nddStatus: complete=${dd.ddCompleteCount}/${dd.ddTotal} canCounter=${dd.canCounter} canSignPA=${dd.canSignPA} volleyState=[t1=${dd.volleyState.text1SentAt ? "sent" : "pending"}, t2=${dd.volleyState.text2SentAt ? "sent" : "pending"}, t3=${dd.volleyState.text3SentAt ? "sent" : "pending"}] missing=[${dd.ddMissingItems.slice(0, 4).join(", ")}${dd.ddMissingItems.length > 4 ? "..." : ""}] nextAction=${dd.recommendedActions[0]?.action ?? "—"}` : "";
      return `### DEAL ${i + 1} — ${ctx.property.address}
recordId: ${ctx.recordId}
agent: ${ctx.agent.name ?? "—"} (phone: ${ctx.agent.phone ?? "—"}, email: ${ctx.agent.email ?? "—"})
outreachStatus: ${r.outreachStatus ?? "—"}
listPrice: ${ctx.property.listPrice ?? "—"}
hoursSinceInbound: ${ctx.hoursSinceInbound ?? "—"}
hoursSinceOutbound: ${ctx.hoursSinceOutbound ?? "—"}
responseDue: ${ctx.responseDue}
multiListingAlert: ${ctx.multiListingAlert}${ac ? `\nagentContext: depthScore=${ac.depthScore} totalListings=${ac.totalListings} totalReplies=${ac.totalReplies} inferredTone=${ac.inferredTone} unanswered=${ac.propertiesWithUnansweredInbound.length} active=${ac.activeProperties.length}` : ""}${ddLine}
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
If propertiesWithUnansweredInbound (per agentContext) is non-empty, prefer card_type="UNANSWERED_INBOUND_BLOCKING" and recommend responding on those threads first.

DD V3.0 ENFORCEMENT (critical):
- If the deal is in 'Negotiating' or 'Response Received' AND ddStatus.canCounter is false, the PRIMARY action MUST be "send_volley_text_1" / "send_volley_text_2" / "send_volley_text_3" (whichever is next per ddStatus.nextAction). card_type should be DD_VOLLEY_TEXT_1_DUE / DD_VOLLEY_TEXT_2_DUE / DD_VOLLEY_TEXT_3_DUE accordingly.
- Use the ddStatus.recommendedActions[0].suggestedDraft as-is for the volley text — these are pre-locked SMS templates and must not be paraphrased.
- DO NOT recommend "counter" actions when canCounter is false.
- If outreachStatus is 'Offer Accepted' AND ddStatus.canSignPA is false, card_type=DD_BLOCKER and surface ddStatus.ddMissingItems in the why_this_matters.
- If pre-offer-screen blocked the listing, card_type=PRE_OFFER_BLOCKED with the blocker reasons in why_this_matters.`;

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
