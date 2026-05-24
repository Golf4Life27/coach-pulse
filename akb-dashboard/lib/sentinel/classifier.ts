// Phase 13 / N.1 — Sentinel inbound-reply classifier.
//
// Calls Anthropic Sonnet to produce a structured SentinelClassification
// from a single inbound reply + listing context. The LLM call itself is
// wrapped behind an injectable fetcher so the pure coercion helpers
// can be unit-tested without hitting the network.
//
// Approval-gated by Phase 13 charter: this module produces a
// classification result. It does NOT write Seller_Motivation_Score,
// does NOT auto-reply, does NOT change Outreach_Status. The N.2/N.3
// layers wire the result into the approval queue + draft generator.

import { synthesize } from "@/lib/maverick/synthesizer";
import { VOICE_REGISTRY } from "@/lib/maverick/voice-registry";
import type {
  SentinelClassification,
  SentinelClassifierInput,
  SentinelIntent,
  SentinelRedFlag,
} from "./types";

/** @deprecated Phase 10 / P.2 — model now resolved via
 *  voice-registry.VOICE_REGISTRY.sentinel.model. This constant
 *  re-exports the registry value so existing imports keep working
 *  during migration. Drop once external callers migrate. */
export const SENTINEL_MODEL = VOICE_REGISTRY.sentinel.model;

const ALLOWED_INTENTS: ReadonlyArray<SentinelIntent> = [
  "motivated",
  "lukewarm",
  "rejection",
  "question",
  "wire_fraud_red_flag",
  "off_topic",
  "spam",
];

const ALLOWED_RED_FLAGS: ReadonlyArray<SentinelRedFlag> = [
  "phishing_link",
  "request_wire_transfer",
  "impersonation",
  "request_routing_number",
  "fake_urgency",
  "deceptive_identity",
  "off_platform_redirect",
];

/** Pure: coerce a freeform model string into a canonical intent.
 *  Anything not in ALLOWED_INTENTS collapses to "off_topic" — the
 *  safest default (operator review without action). */
export function coerceIntent(raw: unknown): SentinelIntent {
  if (typeof raw !== "string") return "off_topic";
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((ALLOWED_INTENTS as readonly string[]).includes(normalized)) {
    return normalized as SentinelIntent;
  }
  return "off_topic";
}

/** Pure: clamp confidence to [0, 1]. Defends against models returning
 *  percentages, negatives, or unbounded floats. */
export function coerceConfidence(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  // Tolerate percentages (>1 but <=100) by dividing by 100.
  if (raw > 1 && raw <= 100) return Math.max(0, Math.min(1, raw / 100));
  return Math.max(0, Math.min(1, raw));
}

/** Pure: filter raw red-flag list to known categories. Unknown
 *  entries are dropped silently — we never want a typo'd flag to
 *  pollute downstream Pulse baselines. Dedupes via Set. */
export function coerceRedFlags(raw: unknown): SentinelRedFlag[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<SentinelRedFlag>();
  for (const f of raw) {
    if (typeof f !== "string") continue;
    const normalized = f.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if ((ALLOWED_RED_FLAGS as readonly string[]).includes(normalized)) {
      out.add(normalized as SentinelRedFlag);
    }
  }
  return Array.from(out);
}

/** Pure: motivation score is only meaningful for motivated/lukewarm
 *  intents. Clamp to integer 1-5 inclusive; null when not applicable
 *  or out of range. */
export function coerceMotivationScore(
  raw: unknown,
  intent: SentinelIntent,
): number | null {
  if (intent !== "motivated" && intent !== "lukewarm") return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}

/** Pure: coerce reasoning to a bounded-length string. The LLM
 *  occasionally returns multi-paragraph rationales; truncate at 500
 *  chars to keep the audit log compact. */
export function coerceReasoning(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length <= 500) return trimmed;
  return `${trimmed.slice(0, 497)}...`;
}

/** Pure: coerce the LLM's freeform JSON output into the canonical
 *  SentinelClassification shape. Exported so N.4 tests can lock the
 *  shape without a live Anthropic call. */
export function coerceClassification(
  raw: unknown,
  model: string = SENTINEL_MODEL,
  now: () => Date = () => new Date(),
): SentinelClassification {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const intent = coerceIntent(obj.intent);
  return {
    intent,
    confidence: coerceConfidence(obj.confidence),
    reasoning: coerceReasoning(obj.reasoning),
    red_flags: coerceRedFlags(obj.red_flags),
    motivation_score_hint: coerceMotivationScore(obj.motivation_score_hint, intent),
    model,
    classified_at: now().toISOString(),
  };
}

const SENTINEL_SYSTEM_PROMPT = `You are Sentinel, the inbound-reply triage agent for AKB Solutions, a Texas/Tennessee/Michigan wholesale-real-estate operator.

Your job: classify a single inbound reply from a listing agent into one of 7 intents, and surface any red flags. Output ONLY a JSON object (no prose, no markdown fences) matching this schema:

{
  "intent": "motivated" | "lukewarm" | "rejection" | "question" | "wire_fraud_red_flag" | "off_topic" | "spam",
  "confidence": <number 0-1>,
  "reasoning": "<1-2 sentence rationale citing specific signals from the reply>",
  "red_flags": ["<flag>", ...],
  "motivation_score_hint": <integer 1-5 ONLY for motivated/lukewarm, else null>
}

Intent taxonomy:
- motivated: Agent/seller expressing clear willingness to engage on price or terms (e.g., a counter, an asking-price suggestion, "send your offer", "let's get on a call"). High intent.
- lukewarm: Soft interest. Agent didn't reject but didn't engage either ("seller wants more", "let me check with seller"). Worth nurturing but not hot.
- rejection: Clear no ("not interested", "off the market", "do not contact", "unsubscribe", "we're firm at list").
- question: Agent asked us a clarifying question that needs an answer before a meaningful response ("send proof of funds", "what's your entity", "are you the end buyer", "when can you close").
- wire_fraud_red_flag: Reply contains phishing / wire-fraud / impersonation patterns. ANY of these → use this intent.
- off_topic: Unrelated reply, accidental send, garbled. No clear signal in any direction.
- spam: Marketing, robocall reply, "got this message in error from a service".

Red flag categories (only set when applicable):
- phishing_link: Contains a URL that doesn't match a known listing/MLS domain
- request_wire_transfer: Asks for a wire before contract
- impersonation: Reply purports to be from a party other than the listing agent
- request_routing_number: Asks for bank routing / account details
- fake_urgency: "Must close in 48 hours" / "deal expires tonight" pressure tactics
- deceptive_identity: Mismatched names, claimed credentials that don't pass smell test
- off_platform_redirect: Asks to move conversation to Telegram/WhatsApp/Signal/email-only

Motivation score (1-5 v1.3 scale, ONLY for motivated/lukewarm):
1 = barely-interested, vague language
2 = soft signal, needs heavy nurture
3 = clear interest, willing to discuss terms
4 = strong intent, mentions specific price or timeline
5 = high motivation, ready to transact ("send the contract", "we accept")

Be conservative. When ambiguous, prefer lower intent / lower confidence. When in doubt about wire-fraud signals, surface the flag — false positives are cheap, missed scams are not.`;

interface CallAnthropicArgs {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTokens?: number;
}

/** Internal: routes through lib/maverick/synthesizer for unified
 *  model resolution + audit-log tagging. Phase 10 / P.2 migration.
 *  The `model` arg on CallAnthropicArgs is now ignored (registry
 *  resolves) but kept for backward-compat with the existing
 *  callAnthropic injection seam. */
async function callAnthropicDefault(args: CallAnthropicArgs): Promise<string> {
  // Phase 10.6 — SENTINEL_SYSTEM_PROMPT is large + stable across
  // every classification call. cache_system: true unlocks Anthropic's
  // prompt-cache pricing tier (~10% cost of full prompt tokens) on
  // repeat invocations within the cache TTL window.
  const result = await synthesize({
    agent: "sentinel",
    system: args.systemPrompt,
    user: args.userPrompt,
    max_tokens: args.maxTokens ?? 512,
    apiKey: args.apiKey,
    event_label: "sentinel_classified",
    cache_system: true,
  });
  return result.text;
}

/** Pure: build the user prompt for a single inbound reply. Exported
 *  so N.4 tests can verify the prompt shape (deterministic) without
 *  a live Anthropic call. */
export function buildClassifierUserPrompt(input: SentinelClassifierInput): string {
  const timeline =
    input.recent_timeline_snippets && input.recent_timeline_snippets.length > 0
      ? `\n\nRecent timeline (oldest → newest):\n${input.recent_timeline_snippets
          .map((s, i) => `${i + 1}. ${s}`)
          .join("\n")}`
      : "";
  const listPriceLine =
    input.listing.list_price != null
      ? `\nList price: $${input.listing.list_price.toLocaleString("en-US")}`
      : "";
  const stateLine = input.listing.state ? `\nState: ${input.listing.state}` : "";
  return `INBOUND REPLY TO CLASSIFY:
"""
${input.body}
"""

Listing context:
Address: ${input.listing.address}${listPriceLine}${stateLine}
Agent: ${input.agent.name ?? "—"}${timeline}

Classify per the schema. JSON only — no prose, no fences.`;
}

/** Pure: strip optional ```json fences and trim before JSON.parse. */
export function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

export interface ClassifyInboundReplyOpts {
  /** Override the model. Defaults to SENTINEL_MODEL. */
  model?: string;
  /** Inject a custom fetcher for tests. Default uses Anthropic
   *  Messages API directly. */
  callAnthropic?: (args: CallAnthropicArgs) => Promise<string>;
  /** Inject a clock for deterministic timestamps in tests. */
  now?: () => Date;
}

/** Classify a single inbound reply. Returns a fully-coerced
 *  SentinelClassification. Throws when ANTHROPIC_API_KEY is missing
 *  and no custom callAnthropic is supplied. */
export async function classifyInboundReply(
  input: SentinelClassifierInput,
  opts: ClassifyInboundReplyOpts = {},
): Promise<SentinelClassification> {
  const model = opts.model ?? SENTINEL_MODEL;
  const fetcher = opts.callAnthropic ?? callAnthropicDefault;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!opts.callAnthropic && !apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set — Sentinel classifier cannot run");
  }

  const userPrompt = buildClassifierUserPrompt(input);
  const rawText = await fetcher({
    apiKey,
    systemPrompt: SENTINEL_SYSTEM_PROMPT,
    userPrompt,
    model,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(rawText));
  } catch {
    // Fall through to coerceClassification with empty input — it
    // produces a safe "off_topic" default with confidence 0.
    parsed = {};
  }

  return coerceClassification(parsed, model, opts.now);
}
