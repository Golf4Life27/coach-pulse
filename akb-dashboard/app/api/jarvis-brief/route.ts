// @deprecated Legacy morning-brief synthesis endpoint. Superseded by
// `/api/maverick/load-state` which uses the Continuity Layer Spec v1.2
// aggregator + synthesizer. Phase 9.11 deprecation tag; URL kept live
// until the Shepherd panel (Phase 9.1) and priority surface (9.2) fully
// replace `MorningBriefing.tsx`'s consumption.

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, getRecentlyDeadCandidates } from "@/lib/airtable";
import { buildJarvisSystemPrompt, computeJarvisScore } from "@/lib/jarvis-system-prompt";
import { getVolleyText } from "@/lib/dd-volley";
import { applyResurrection, evaluateResurrection } from "@/lib/resurrection";
import { parseConversation } from "@/lib/notes";
import { compressForLLM, renderCompressedTimeline } from "@/lib/jarvis-llm-context";
import type { Listing } from "@/lib/types";
import type {
  AgentContext,
  BroCard,
  CardType,
  DDStatus,
  DealContext,
  JarvisBrief,
} from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BROCARDS = 3;
const MAX_RANKED_FOR_LLM = 5;
// Top-K survivors after Pass 1 preliminary scoring. These get fully
// hydrated in Pass 2 (deal-context + agent-context + dd-status). We only
// surface MAX_BROCARDS cards at the end, so 5 gives the LLM enough
// headroom for re-ranking without burning Pass 2 time on candidates
// that have ~0 chance of placing in the top 3.
const MAX_HYDRATE_CANDIDATES = 5;

const ACCEPT_NOTE_RE = /accept|seller (?:agreed|said yes)|will move forward/i;
const COUNTER_NOTE_RE = /counter|come up|come down/i;

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";

interface RankedDeal {
  context: DealContext;
  score: number;
  outreachStatus: string | null;
  agentContext: AgentContext | null;
  ddStatus: DDStatus | null;
  resurrected?: boolean;
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
    dealStage: ctx.dealStage,
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

// Pass 1: cheap, field-only score. NEVER fetch external APIs from this
// helper — it must run synchronously over an in-memory listing array. The
// goal is to shrink the candidate pool from N (35+) down to
// MAX_HYDRATE_CANDIDATES before we do any expensive deal-context work.
function computePreliminaryScore(l: Listing): number {
  let score = 0;

  switch (l.outreachStatus) {
    case "Negotiating": score += 50; break;
    case "Response Received": score += 40; break;
    case "Offer Accepted": score += 30; break;
    case "Texted": score += 20; break;
    case "Emailed": score += 10; break;
  }

  const hoursSinceInbound = l.lastInboundAt
    ? Math.floor((Date.now() - new Date(l.lastInboundAt).getTime()) / 3_600_000)
    : null;
  if (hoursSinceInbound != null) {
    if (hoursSinceInbound <= 24) score += 30;
    else if (hoursSinceInbound <= 72) score += 20;
    else if (hoursSinceInbound <= 168) score += 10;
    else if (hoursSinceInbound > 14 * 24) score -= 20;
  }

  // Cheap textual signals on Notes — full deal-stage detection runs in Pass 2,
  // but we want acceptance/counter language to lift candidates into the top-10
  // even when their Outreach_Status hasn't been updated.
  const notes = l.notes ?? "";
  if (notes && ACCEPT_NOTE_RE.test(notes)) score += 20;
  if (notes && COUNTER_NOTE_RE.test(notes)) score += 10;

  return score;
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
      dealStage: deal.context.dealStage,
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

  const tStart = Date.now();
  const resurrectedRecordIds = new Set<string>();
  try {
    // FETCH — server-side filtered. Only pulls records the brief actually
    // cares about, avoiding the ~1,200-record full-table scan that was
    // tipping us past the 60s cap.
    const tFetch = Date.now();
    const [active, deadCandidates] = await Promise.all([
      getActiveListingsForBrief({ recentDays: 7 }),
      getRecentlyDeadCandidates({ maxAgeDays: 30, cap: 50 }),
    ]);
    const fetchMs = Date.now() - tFetch;
    console.log(`[jarvis-brief] fetch=${fetchMs}ms active=${active.length} deadCandidates=${deadCandidates.length}`);

    const origin = originFromReq(req);
    const cookie = req.headers.get("cookie");

    // PASS 1 — preliminary scoring + capped resurrection sweep.
    const tPass1 = Date.now();

    // Resurrection sweep over the capped Dead pool only (max 50 records).
    // Cheap: notes parsing in-memory + Airtable update fire-and-forget.
    const resurrected: Listing[] = [];
    for (const l of deadCandidates) {
      const entries = parseConversation(l.notes);
      const lastInboundEntry = [...entries].reverse().find((e) => e.type === "inbound");
      const evalResult = evaluateResurrection(l, lastInboundEntry?.text ?? null);
      if (evalResult.resurrected && evalResult.inboundSnippet) {
        resurrected.push(l);
        resurrectedRecordIds.add(l.id);
        // Fire-and-forget Airtable update + audit note.
        void applyResurrection(l, evalResult.inboundSnippet);
      }
    }
    // Resurrected records virtually flip to Response Received so downstream
    // stage detection + scoring treats them correctly.
    const activeWithResurrected: Listing[] = [
      ...active,
      ...resurrected.map((l) => ({ ...l, outreachStatus: "Response Received" } as Listing)),
    ];

    const preliminaryRanked = activeWithResurrected
      .map((l) => {
        let prelim = computePreliminaryScore(l);
        // Resurrected records get +90 — high-leverage missed-opportunity recovery.
        if (resurrectedRecordIds.has(l.id)) prelim += 90;
        return { listing: l, prelim };
      })
      .sort((a, b) => b.prelim - a.prelim)
      .slice(0, MAX_HYDRATE_CANDIDATES);
    const pass1Ms = Date.now() - tPass1;
    console.log(`[jarvis-brief] pass1=${pass1Ms}ms (active=${active.length} resurrected=${resurrected.length} candidates=${preliminaryRanked.length})`);

    // PASS 2 — fully hydrate the top-K candidates only. deal-context for each
    // is fetched in parallel; per-candidate, deal-context fans out internally.
    // Failed fetches are logged + skipped; we never fail the whole brief.
    const tPass2 = Date.now();
    const contexts = await Promise.all(
      preliminaryRanked.map((p) =>
        fetchDealContext(origin, p.listing.id, cookie)
          .then((ctx) => ({ listing: p.listing, prelim: p.prelim, ctx }))
          .catch((err) => {
            console.error(`[jarvis-brief] deal-context failed for ${p.listing.id}:`, err);
            return { listing: p.listing, prelim: p.prelim, ctx: null as DealContext | null };
          }),
      ),
    );

    const ranked: RankedDeal[] = contexts
      .filter((x): x is { listing: typeof x.listing; prelim: number; ctx: DealContext } => Boolean(x.ctx))
      .map((x) => {
        const status = x.listing.outreachStatus;
        let score = computeJarvisScore({
          hoursSinceInbound: x.ctx.hoursSinceInbound,
          lastInboundBody: (x.ctx.metadata?.lastInboundBody as string) ?? null,
          outreachStatus: status,
          multiListingAlert: x.ctx.multiListingAlert,
        });
        const resurrected = resurrectedRecordIds.has(x.listing.id);
        if (resurrected) score += 90;
        return {
          context: x.ctx,
          score,
          outreachStatus: status,
          agentContext: null,
          ddStatus: null,
          resurrected,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RANKED_FOR_LLM);

    // Hydrate agentContext + ddStatus in parallel for the top-N.
    await Promise.all(
      ranked.map(async (r) => {
        const id = r.context.agent.phone ?? r.context.agent.email;
        const [acRes, ddRes] = await Promise.allSettled([
          id ? fetchAgentContext(origin, id, cookie) : Promise.resolve(null),
          fetchDDStatus(origin, r.context.recordId, cookie),
        ]);
        r.agentContext = acRes.status === "fulfilled" ? acRes.value : null;
        r.ddStatus = ddRes.status === "fulfilled" ? ddRes.value : null;
        if (acRes.status === "rejected") console.error(`[jarvis-brief] agent-context failed for ${r.context.recordId}:`, acRes.reason);
        if (ddRes.status === "rejected") console.error(`[jarvis-brief] dd-status failed for ${r.context.recordId}:`, ddRes.reason);

        // Stage-aware bumps. Critical near-term signals beat DD-blocker urgency.
        const stage = r.context.dealStage;
        const signals = r.context.dealStageSignals;
        if (signals?.costClarificationPending) r.score += 80;       // highest — Alex owes / awaits a number
        if (signals?.paDrafting) r.score += 70;                     // PA is being drafted; respond now
        if (stage === "accepted_pending_pa") r.score += 60;
        if (stage === "inspection") r.score += 50;
        if (stage === "won") r.score = Math.max(0, r.score - 100);  // de-prioritize closed deals

        // DD score bump (existing): incomplete DD on Negotiating/Offer Accepted
        // makes "send volley" the primary action and adds +50 to score. We
        // keep this AFTER the stage bumps so cost/PA signals can still lead.
        if (r.ddStatus && (r.ddStatus.recommendedActions[0]?.action ?? "").startsWith("send_volley_text_")) {
          r.score += 50;
        }
      }),
    );
    const pass2Ms = Date.now() - tPass2;

    // Re-sort after the bumps so the LLM sees the most-urgent deals first.
    ranked.sort((a, b) => b.score - a.score);

    console.log(`[jarvis-brief] pass2=${pass2Ms}ms (hydrated=${ranked.length})`);

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
      console.log(`[jarvis-brief] empty (no hydrated candidates) total=${Date.now() - tStart}ms`);
      return NextResponse.json(empty);
    }

    const system = buildJarvisSystemPrompt({
      context: "brief",
      includeDepthAwareDrafting: true,
    });

    const dealBlocks = ranked.map((r, i) => {
      const ac = r.agentContext;
      const dd = r.ddStatus;
      const compressed = compressForLLM(r.context);
      const lastInBody = compressed.lastInboundBody ?? "—";
      const ddLine = dd ? `\nddStatus: complete=${dd.ddCompleteCount}/${dd.ddTotal} canCounter=${dd.canCounter} canSignPA=${dd.canSignPA} volleyState=[t1=${dd.volleyState.text1SentAt ? "sent" : "pending"}, t2=${dd.volleyState.text2SentAt ? "sent" : "pending"}, t3=${dd.volleyState.text3SentAt ? "sent" : "pending"}] missing=[${dd.ddMissingItems.slice(0, 4).join(", ")}${dd.ddMissingItems.length > 4 ? "..." : ""}] nextAction=${dd.recommendedActions[0]?.action ?? "—"}${dd.ddInformalAnsweredItems && dd.ddInformalAnsweredItems.length > 0 ? ` informallyAnswered=[${dd.ddInformalAnsweredItems.slice(0, 6).join(", ")}]` : ""}` : "";
      const stageLine = compressed.dealStage
        ? `\ndealStage: ${compressed.dealStage} signals=[paDrafting=${compressed.dealStageSignals?.paDrafting ?? false}, costClarificationPending=${compressed.dealStageSignals?.costClarificationPending ?? false}, inspectionStarted=${compressed.dealStageSignals?.inspectionStarted ?? false}]`
        : "";
      const resurrectedLine = r.resurrected ? `\nresurrected: true (was Dead, fresh non-rejection inbound just landed)` : "";
      const notesLine = compressed.notesTail ? `\nnotesTail (last ~1000 chars): ${compressed.notesTail}` : "";
      return `### DEAL ${i + 1} — ${compressed.property.address}
recordId: ${compressed.recordId}
agent: ${compressed.agent.name ?? "—"} (phone: ${compressed.agent.phone ?? "—"}, email: ${compressed.agent.email ?? "—"})
outreachStatus: ${r.outreachStatus ?? "—"}${stageLine}${resurrectedLine}
listPrice: ${compressed.property.listPrice ?? "—"}
hoursSinceInbound: ${compressed.hoursSinceInbound ?? "—"}
hoursSinceOutbound: ${compressed.hoursSinceOutbound ?? "—"}
responseDue: ${compressed.responseDue}
multiListingAlert: ${compressed.multiListingAlert}${ac ? `\nagentContext: depthScore=${ac.depthScore} totalListings=${ac.totalListings} totalReplies=${ac.totalReplies} inferredTone=${ac.inferredTone} unanswered=${ac.propertiesWithUnansweredInbound.length} active=${ac.activeProperties.length} isPrincipal=${ac.isPrincipal ?? false}${ac.principalSignal ? ` principalSignal="${ac.principalSignal.replace(/"/g, "'").slice(0, 80)}"` : ""}` : ""}${ddLine}
lastInboundBody: ${lastInBody}${notesLine}
recent timeline (last ${compressed.timeline.length} conversational entries${compressed.timelineDroppedCount > 0 ? `, ${compressed.timelineDroppedCount} older dropped` : ""}):
${renderCompressedTimeline(compressed)}
score: ${r.score}`;
    }).join("\n\n");

    const userPrompt = `Here are the top ${ranked.length} active deals ranked by Jarvis score. Pick the top ${MAX_BROCARDS} that need Alex's attention NOW and emit BroCards.

${dealBlocks}

Output ONLY a JSON array (no prose, no markdown fences). Each element must be a BroCard:
{
  "rank": 1,
  "recordId": "rec...",
  "card_type": "NEGOTIATION_RESPONSE_DUE" | "OFFER_ACCEPTED_PA_NEEDED" | "STALE_REENGAGEMENT" | "AMBIGUOUS_NEEDS_REVIEW" | "UNANSWERED_INBOUND_BLOCKING" | "PRE_OFFER_BLOCKED" | "DD_BLOCKER" | "DD_VOLLEY_TEXT_1_DUE" | "DD_VOLLEY_TEXT_2_DUE" | "DD_VOLLEY_TEXT_3_DUE" | "DD_VOLLEY_COMPLETE" | "BUYER_MATCH_READY" | "BUYER_WARMUP_DUE" | "BUYER_FORM_COMPLETED" | "BUYER_BLAST_RECOMMENDED" | "PA_DRAFTING_AWAITING_RESPONSE" | "COST_CLARIFICATION_PENDING" | "POST_ACCEPTANCE_DD_DUE" | "AWAITING_BUYER_PIPELINE",
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
- If pre-offer-screen blocked the listing, card_type=PRE_OFFER_BLOCKED with the blocker reasons in why_this_matters.

STAGE-AWARE CARD SELECTION (overrides DD/negotiation defaults when post-acceptance dynamics are in play):
- dealStage='accepted_pending_pa' AND signals.costClarificationPending=true: card_type=COST_CLARIFICATION_PENDING. PRIMARY action is to respond with the cost breakdown (or to ask the agent for theirs if we owe them). DD volley still surfaces as a SECONDARY card if applicable but never as primary on this deal.
- dealStage='accepted_pending_pa' AND signals.paDrafting=true: card_type=PA_DRAFTING_AWAITING_RESPONSE. PRIMARY action is to send the PA-relevant info (entity name, signing party, etc.). If DD is incomplete and the agent is drafting, secondary card_type=POST_ACCEPTANCE_DD_DUE warning that DD must be done before PA signs.
- dealStage='accepted_pending_pa' with no signals: card_type=OFFER_ACCEPTED_PA_NEEDED with primary action to push for PA timing.
- dealStage='inspection': card_type=DD_BLOCKER if any DD missing, otherwise STALE_REENGAGEMENT keyed to inspection scheduling.
- dealStage='won' or 'dead': skip — do not surface.

Where signals.costClarificationPending or signals.paDrafting are true, NEVER produce a draft that re-introduces Alex with the cold script. Honor depthScore + dealStage together.

RESURRECTION (when resurrected: true on a deal block):
- card_type=RESURRECTION_OPPORTUNITY (CRITICAL urgency).
- The agent was previously dead and just sent a non-rejection inbound. Highest score in the brief.
- summary should reference the resurrection event ("Re-engaged after going dark — agent reached out today").
- Drafted reply should be casual + responsive — never the cold script. Reference the gap warmly ("Good to hear from you again").

PRINCIPAL HANDLING (when agentContext.isPrincipal is true):
- The "agent" is also the seller (or family-owner). Treat them as a decisionmaker, not as a listing-only intermediary.
- Address by first name only ("Hey Kim" not "Kim Maloney").
- Ask direct decisionmaker questions when negotiating ("what number actually gets this done for you?", "what are the must-haves on terms?"). Avoid agent-speak like "please ask the seller…" — they ARE the seller.
- Reference family/ownership context respectfully if mentioned (estate, family liquidation, etc.).
- Wholesale assignment language can be more direct.

MULTIFAMILY COUNTER PRICING:
- For multi-unit / non-SFR deals (4+ units, "plex" in address, or property type signals multifamily), do NOT default to the 65%-of-list rule when drafting a counter.
- Compute: counter ≈ (Buyer's max acquisition based on cap-rate target) − $15K wholesale fee. Round to nearest $1K.
- A reasonable buyer cap-rate target for 8-12% gross-rent multiplier markets: gross_rent_annual / 0.08–0.10.
- If you cannot estimate gross rent, surface the deal as STALE_REENGAGEMENT asking for rent roll BEFORE proposing a counter.
- Show the math in the BroCard summary: "8 units × $700/mo × 12 = $67,200 gross → buyer max ~$745K at 9% cap → counter $445K (yields $15K wholesale fee at $460K assignment)".`;

    const tLLM = Date.now();
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
    const llmMs = Date.now() - tLLM;

    // Ensure agentContext + dealStage are present on every card (LLM may
    // drop them — they live outside the JSON contract since the prompt
    // doesn't ask for them explicitly).
    cards = cards.map((c) => {
      const r = ranked.find((x) => x.context.recordId === c.recordId);
      const out: typeof c = { ...c };
      if (!out.agentContext && r?.agentContext) out.agentContext = r.agentContext;
      if (!out.dealStage && r?.context.dealStage) out.dealStage = r.context.dealStage;
      return out;
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

    const totalMs = Date.now() - tStart;
    console.log(`[jarvis-brief] llm=${llmMs}ms total=${totalMs}ms cards=${cards.length}`);

    return NextResponse.json(brief);
  } catch (err) {
    console.error("[jarvis-brief] error:", err);
    return NextResponse.json(
      { error: "Failed to build brief", detail: String(err) },
      { status: 500 },
    );
  }
}
