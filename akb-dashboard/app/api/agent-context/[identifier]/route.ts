import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";
import { getThreadsForEmail } from "@/lib/gmail";
import { parseConversation } from "@/lib/notes";
import type {
  AgentContext,
  AgentContextProperty,
  AgentContextUnanswered,
  DepthScore,
  InferredTone,
} from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 30;

const CACHE_TTL_MS = 60_000;
const cache: Record<string, { data: AgentContext; timestamp: number }> = {};

const DEAD_STATUSES = new Set(["Dead", "Walked", "Terminated", "No Response"]);
const WON_STATUSES = new Set(["Won", "Closed", "Contract Signed"]);

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

function looksLikePhone(s: string): boolean {
  return /^[+\d\s\-().]+$/.test(s) && s.replace(/\D/g, "").length >= 7;
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

async function inferTone(
  inboundBodies: string[],
  apiKey: string | undefined,
): Promise<InferredTone> {
  if (!apiKey || inboundBodies.length === 0) return "transactional";
  const sample = inboundBodies.slice(-5).join("\n---\n").slice(0, 4000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        system:
          "You classify a real-estate agent's writing tone in one word. Reply with EXACTLY one of: formal, casual, friendly, transactional. No punctuation, no other words.",
        messages: [
          { role: "user", content: `Last messages from agent:\n${sample}` },
        ],
      }),
    });
    if (!res.ok) return "transactional";
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((b) => b.type === "text")?.text?.trim().toLowerCase() ?? "";
    if (text === "formal" || text === "casual" || text === "friendly" || text === "transactional") {
      return text;
    }
    return "transactional";
  } catch {
    return "transactional";
  }
}

function computeDepthScore(opts: {
  totalOutreaches: number;
  totalReplies: number;
  totalListings: number;
  hasWon: boolean;
}): DepthScore {
  if (opts.totalReplies >= 5 || opts.totalListings >= 3 || opts.hasWon) return 3;
  if (opts.totalReplies >= 1) return 2;
  if (opts.totalOutreaches >= 1) return 1;
  return 0;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ identifier: string }> },
) {
  const { identifier: rawIdentifier } = await params;
  const identifier = decodeURIComponent(rawIdentifier ?? "").trim();

  if (!identifier) {
    return NextResponse.json({ error: "Missing identifier" }, { status: 400 });
  }

  const cacheKey = identifier.toLowerCase();
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  const isPhone = looksLikePhone(identifier);
  const targetPhone = isPhone ? normalizePhone(identifier) : null;
  const targetEmail = !isPhone ? normalizeEmail(identifier) : null;

  try {
    const allListings = await getListings();

    const matched = allListings.filter((l) => {
      if (targetPhone && l.agentPhone && normalizePhone(l.agentPhone) === targetPhone) return true;
      if (targetEmail && l.agentEmail && normalizeEmail(l.agentEmail) === targetEmail) return true;
      return false;
    });

    const agentName =
      matched.find((l) => l.agentName && l.agentName.trim())?.agentName?.trim() ?? "Agent";

    // Per-listing aggregates from Notes + lastInbound/lastOutbound stamps.
    let totalOutreaches = 0;
    let totalReplies = 0;
    let lastInteractionAt: string | null = null;
    let hasWon = false;
    const activeProperties: AgentContextProperty[] = [];
    const propertiesWithUnansweredInbound: AgentContextUnanswered[] = [];
    const inboundBodyAccumulator: { ts: number; body: string }[] = [];

    for (const l of matched) {
      const status = l.outreachStatus ?? "";
      if (WON_STATUSES.has(status)) hasWon = true;
      if (!DEAD_STATUSES.has(status) && !WON_STATUSES.has(status)) {
        activeProperties.push({ recordId: l.id, address: l.address, status });
      }

      const entries = parseConversation(l.notes);
      for (const e of entries) {
        if (e.type === "outbound") totalOutreaches += 1;
        else if (e.type === "inbound") {
          totalReplies += 1;
          if (e.text) {
            const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
            inboundBodyAccumulator.push({ ts: isNaN(ts) ? 0 : ts, body: e.text });
          }
        }
      }

      if (l.lastInboundAt) {
        if (!lastInteractionAt || new Date(l.lastInboundAt) > new Date(lastInteractionAt)) {
          lastInteractionAt = l.lastInboundAt;
        }
      }
      if (l.lastOutboundAt) {
        if (!lastInteractionAt || new Date(l.lastOutboundAt) > new Date(lastInteractionAt)) {
          lastInteractionAt = l.lastOutboundAt;
        }
      }

      // Unanswered inbound = lastInboundAt > lastOutboundAt.
      if (l.lastInboundAt && (!l.lastOutboundAt || new Date(l.lastInboundAt) > new Date(l.lastOutboundAt))) {
        if (!DEAD_STATUSES.has(status)) {
          propertiesWithUnansweredInbound.push({
            recordId: l.id,
            address: l.address,
            lastInboundAt: l.lastInboundAt,
          });
        }
      }
    }

    // Pull live Quo messages — counts may exceed Notes, so prefer them when present.
    let quoOutbound = 0;
    let quoInbound = 0;
    let quoLastInbound: string | null = null;
    let quoLastOutbound: string | null = null;
    if (targetPhone && process.env.QUO_API_KEY) {
      try {
        const quoMsgs = await getMessagesForParticipant(targetPhone, 60 * 24 * 90);
        for (const m of quoMsgs) {
          if (m.direction === "outgoing") {
            quoOutbound += 1;
            if (!quoLastOutbound || new Date(m.createdAt) > new Date(quoLastOutbound)) {
              quoLastOutbound = m.createdAt;
            }
          } else {
            quoInbound += 1;
            if (!quoLastInbound || new Date(m.createdAt) > new Date(quoLastInbound)) {
              quoLastInbound = m.createdAt;
            }
            const ts = m.createdAt ? new Date(m.createdAt).getTime() : 0;
            if (m.body) inboundBodyAccumulator.push({ ts: isNaN(ts) ? 0 : ts, body: m.body });
          }
        }
      } catch (err) {
        console.error(`[agent-context] Quo fetch failed for ${identifier}:`, err);
      }
    }

    // Pull Gmail (currently a stub).
    if (targetEmail) {
      try {
        const threads = await getThreadsForEmail(targetEmail);
        for (const t of threads) {
          inboundBodyAccumulator.push({ ts: new Date(t.date).getTime() || 0, body: t.body });
        }
      } catch (err) {
        console.error(`[agent-context] Gmail fetch failed for ${identifier}:`, err);
      }
    }

    // Use live Quo counts when available — they're authoritative; fall back to Notes.
    const finalOutreaches = Math.max(totalOutreaches, quoOutbound);
    const finalReplies = Math.max(totalReplies, quoInbound);
    if (quoLastInbound && (!lastInteractionAt || new Date(quoLastInbound) > new Date(lastInteractionAt))) {
      lastInteractionAt = quoLastInbound;
    }
    if (quoLastOutbound && (!lastInteractionAt || new Date(quoLastOutbound) > new Date(lastInteractionAt))) {
      lastInteractionAt = quoLastOutbound;
    }

    const daysSinceLastInteraction = lastInteractionAt
      ? Math.floor((Date.now() - new Date(lastInteractionAt).getTime()) / 86_400_000)
      : null;

    const depthScore = computeDepthScore({
      totalOutreaches: finalOutreaches,
      totalReplies: finalReplies,
      totalListings: matched.length,
      hasWon,
    });

    const inboundBodies = inboundBodyAccumulator
      .sort((a, b) => a.ts - b.ts)
      .map((x) => x.body)
      .filter((b) => b.length > 5);

    const inferredTone = await inferTone(inboundBodies, process.env.ANTHROPIC_API_KEY);

    const context: AgentContext = {
      identifier,
      agentName,
      totalListings: matched.length,
      totalOutreaches: finalOutreaches,
      totalReplies: finalReplies,
      lastInteractionAt,
      daysSinceLastInteraction,
      activeProperties,
      propertiesWithUnansweredInbound,
      depthScore,
      inferredTone,
      metadata: {
        matchedRecordIds: matched.map((l) => l.id),
        notesOutreaches: totalOutreaches,
        notesReplies: totalReplies,
        quoOutreaches: quoOutbound,
        quoReplies: quoInbound,
        hasWon,
      },
    };

    cache[cacheKey] = { data: context, timestamp: Date.now() };
    return NextResponse.json(context);
  } catch (err) {
    console.error(`[agent-context] error for ${identifier}:`, err);
    return NextResponse.json(
      { error: "Failed to load agent context", detail: String(err), identifier },
      { status: 500 },
    );
  }
}
