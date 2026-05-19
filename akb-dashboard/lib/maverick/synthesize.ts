// Maverick — Claude API narrative synthesizer.
// @agent: maverick (Day 2)
//
// Wraps the structured briefing in Owner's Rep voice. Strict
// guardrails: Claude paraphrases the deterministic facts, never
// substitutes for them. The hybrid template-Claude pattern protects
// against hallucination on counts, addresses, principle IDs.
//
// Budget: 12s. If exceeded, the aggregator falls back to the
// template-only narrative (already deterministic from
// lib/maverick/template.ts).
//
// Prompt caching: the system prompt (Owner's Rep voice + agent
// roster + Maverick principles) is marked cache_control: ephemeral
// so successive session-opens within the cache TTL window get the
// cheaper cached-input pricing.

import type { StructuredBriefing } from "./briefing";
import { synthesize } from "./synthesizer";
import { VOICE_REGISTRY } from "./voice-registry";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Bumped from 12s → 20s after Gate 2 first smoke (5/15): cold-cache
// synthesis timed out at 12s with ~10K-token payload (41 active deals).
// Prompt-cache-warm calls complete in ~5-8s; 20s headroom for cold
// path. Aggregator overall budget (30s P95) still satisfied —
// parallel fetch floor is ~3.5s, leaving 26.5s for synthesis.
// v1.2 backlog: trim active_deals input to top 15 to reduce
// Claude latency further.
const DEFAULT_TIMEOUT_MS = 20_000;
/** @deprecated Phase 10 / P.2 — model + max_tokens resolved via
 *  voice-registry.briefing. Constants retained for test access. */
const MODEL = VOICE_REGISTRY.briefing.model;
const MAX_TOKENS = 1024;

// Voice guidance + roster + non-hallucination guardrail. Marked for
// prompt caching since this is the largest stable chunk of input.
const SYSTEM_PROMPT = `You are Maverick — the persistent intelligence layer for Alex Balog's AKB Inevitable wholesale real estate system.

Your role at session open: produce a single concise narrative (200-400 words) that re-grounds a new Claude session in the current operational state. The reader is a Claude session that will pick up work from here.

Voice: Owner's Rep. You speak as someone whose job is to protect Alex's time, sanity, and the years he's trying not to waste with his family. Direct, opinionated, weight-bearing on what matters. Not a dashboard. Not bullet-point soup. A coherent re-grounding.

Named-agent roster (use these names when referring to system components):
- Sentinel (intake), Appraiser (valuation), Forge (drafting), Crier (SMS dispatch + cadence),
- Sentry (gate enforcement), Scribe (contracts), Scout (buyer pipeline),
- Pulse (system health), Ledger (revenue/cost), Maverick (orchestrator — you)

Hard rules — non-negotiable:
1. NEVER invent or substitute deterministic facts. Counts, addresses, SHAs, dates, principle IDs, dollar amounts: if a number or string isn't in the structured data I give you, it doesn't exist. Paraphrase the facts; never fabricate.
2. NEVER include phrases like "let me know if you need more detail" or "happy to help" — you are an intelligence layer, not a chatbot.
3. Prefer specifics over generalities. "23 Fields Ave in Memphis, Negotiating at $61,750, last inbound 2 days ago" beats "an active deal in negotiation."
4. Surface what matters. If there are open decisions waiting on Alex, lead with them. If a deploy is behind HEAD, say so. If RentCast burn rate predicts exhaustion in <14 days, flag it.
5. End with: "What do you want to work on?" — verbatim, single line.

You will receive a structured JSON payload of the current state. Paraphrase it into the narrative described above. Output only the narrative — no preamble, no JSON echo, no metadata.`;

export interface SynthesizeOpts {
  structured: StructuredBriefing;
  timeoutMs?: number;
  // Caller provides the fallback narrative (typically rendered from
  // lib/maverick/template.renderTemplate). On synthesis timeout or
  // error we return this verbatim so the aggregator's response shape
  // stays consistent regardless of synthesis outcome.
  fallbackNarrative: string;
}

export interface SynthesizeResult {
  narrative: string;
  synthesized: boolean;
  error: string | null;
  latency_ms: number;
}

/**
 * Synthesize the narrative, with hard 12s budget + fallback.
 */
export async function synthesizeNarrative(opts: SynthesizeOpts): Promise<SynthesizeResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!ANTHROPIC_API_KEY) {
    return {
      narrative: opts.fallbackNarrative,
      synthesized: false,
      error: "ANTHROPIC_API_KEY not configured",
      latency_ms: Date.now() - t0,
    };
  }

  // Phase 10 / P.2 migration — route through unified synthesizer.
  // Returns fallback narrative on ANY error (timeout, API error,
  // empty response) so the aggregator's response shape stays
  // consistent. Cache-control on system prompt preserved via
  // cache_system flag.
  try {
    const requestBody = buildRequestBody(opts.structured);
    const userContent = requestBody.messages as Array<{ content: string }>;
    const result = await synthesize({
      agent: "briefing",
      system: SYSTEM_PROMPT,
      user: userContent[0].content,
      max_tokens: MAX_TOKENS,
      timeoutMs,
      cache_system: true,
      event_label: "jarvis_brief_synthesized",
    });
    const text = result.text.trim();
    if (!text) {
      return {
        narrative: opts.fallbackNarrative,
        synthesized: false,
        error: "Anthropic response had no text content",
        latency_ms: Date.now() - t0,
      };
    }
    return {
      narrative: text,
      synthesized: true,
      error: null,
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      narrative: opts.fallbackNarrative,
      synthesized: false,
      error: /aborted/i.test(msg) ? `synthesis timeout after ${timeoutMs}ms` : msg,
      latency_ms: Date.now() - t0,
    };
  }
}

/**
 * Pure builder for the Anthropic request body. Exported so tests
 * can assert the prompt structure (system prompt content, cache
 * markers, user-content shape) without making an API call.
 */
export function buildRequestBody(structured: StructuredBriefing): Record<string, unknown> {
  // Phase 9.4a: `audit_summary.recent_events` is a bulk client-side
  // field for factory-floor agent rooms (~1.8K tokens at 50 entries).
  // Synthesizer doesn't need it — `by_agent` counts + `recent_failures`
  // give it enough signal. Strip before serializing to keep the prompt
  // at its prior cost ceiling.
  const synthesisStructured: StructuredBriefing = {
    ...structured,
    audit_summary: {
      ...structured.audit_summary,
      recent_events: [],
    },
  };
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Current operational state (structured JSON):\n\n\`\`\`json\n${JSON.stringify(
          synthesisStructured,
          null,
          2,
        )}\n\`\`\`\n\nProduce the session-open briefing.`,
      },
    ],
  };
}
