// Phase 13 / N.2 — Sentinel reply drafter.
//
// Composes 1-3 proposed replies for an inbound classification.
// Approval-gated per Phase 13 charter: produces drafts only, never
// auto-sends. The Sentinel-room approval queue (N.3) is what
// surfaces these drafts to the operator for one-click approve /
// edit / reject.
//
// Option semantics (stable IDs the UI keys off):
//   firm_hold        — Reassert our number; stand firm on price.
//   soft_counter     — Acknowledge their position, move modestly.
//   ask_for_pof      — Request proof-of-funds / entity info before
//                      engaging on price further.
//   soft_nurture     — Keep the door open without committing to
//                      price movement (lukewarm responses).
//   answer_question  — Direct, factual answer to a specific question
//                      they asked (POF, timeline, entity, end-buyer).
//   decline_politely — Polite walk-away that preserves relationship
//                      for future deals (rejection intent only).
//   alert_only       — No draft. Wire-fraud / spam / off-topic
//                      intents — operator escalation, no reply.
//
// Pure helpers (optionsForIntent, coerceDraft, coerceDraftPackage)
// exported so N.4 tests can lock the shape without a live Anthropic
// call.

import { synthesize } from "@/lib/maverick/synthesizer";
import type { SentinelClassification, SentinelClassifierInput } from "./types";
import { SENTINEL_MODEL } from "./classifier";

export type SentinelDraftOption =
  | "firm_hold"
  | "soft_counter"
  | "ask_for_pof"
  | "soft_nurture"
  | "answer_question"
  | "decline_politely"
  | "alert_only";

export type SentinelDraftChannel = "sms" | "email" | "none";

export interface SentinelDraft {
  /** Stable option ID — the UI uses this for keying + analytics. */
  option: SentinelDraftOption;
  /** Human-readable label for the option button. */
  label: string;
  /** SMS for short replies, email for longer / multi-paragraph,
   *  "none" for the alert_only path. */
  channel: SentinelDraftChannel;
  /** Ready-to-send body. Empty string when channel === "none". */
  body: string;
  /** Optional subject line for email drafts. */
  subject?: string;
}

export interface SentinelDraftPackage {
  /** Empty array when intent is alert_only (wire-fraud / off-topic /
   *  spam) — Sentinel surfaces the classification only, no draft. */
  drafts: SentinelDraft[];
  /** Index of the option Sentinel recommends. 0 by default; LLM
   *  can override. Always 0 when drafts is empty. */
  recommended_index: number;
  /** Echo of the classification that drove this draft package, so
   *  the approval queue can render the full audit trail. */
  classification: SentinelClassification;
  /** Model identifier — locked for Pulse-drift detection. */
  model: string;
  /** ISO timestamp. */
  generated_at: string;
}

const ALLOWED_OPTIONS: ReadonlyArray<SentinelDraftOption> = [
  "firm_hold",
  "soft_counter",
  "ask_for_pof",
  "soft_nurture",
  "answer_question",
  "decline_politely",
  "alert_only",
];

const ALLOWED_CHANNELS: ReadonlyArray<SentinelDraftChannel> = ["sms", "email", "none"];

const OPTION_LABELS: Record<SentinelDraftOption, string> = {
  firm_hold: "Firm hold",
  soft_counter: "Soft counter",
  ask_for_pof: "Ask for POF",
  soft_nurture: "Soft nurture",
  answer_question: "Answer question",
  decline_politely: "Decline politely",
  alert_only: "Alert only",
};

/** Pure: enumerate the draft options Sentinel should generate for a
 *  given intent. Returns [] for intents that don't warrant a draft
 *  (wire-fraud / off-topic / spam). */
export function optionsForIntent(
  intent: SentinelClassification["intent"],
): SentinelDraftOption[] {
  switch (intent) {
    case "motivated":
      return ["firm_hold", "soft_counter", "ask_for_pof"];
    case "lukewarm":
      return ["soft_nurture", "ask_for_pof"];
    case "rejection":
      return ["decline_politely"];
    case "question":
      return ["answer_question"];
    case "wire_fraud_red_flag":
    case "off_topic":
    case "spam":
      return [];
  }
}

/** Pure: filter a raw option-string to a known ID; default
 *  alert_only on miss. Normalizes spaces / dashes. */
export function coerceDraftOption(raw: unknown): SentinelDraftOption {
  if (typeof raw !== "string") return "alert_only";
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((ALLOWED_OPTIONS as readonly string[]).includes(normalized)) {
    return normalized as SentinelDraftOption;
  }
  return "alert_only";
}

/** Pure: clamp channel to {sms, email, none}. Default sms. */
export function coerceChannel(raw: unknown): SentinelDraftChannel {
  if (typeof raw !== "string") return "sms";
  const normalized = raw.trim().toLowerCase();
  if ((ALLOWED_CHANNELS as readonly string[]).includes(normalized)) {
    return normalized as SentinelDraftChannel;
  }
  return "sms";
}

/** Pure: coerce a freeform model draft into the canonical shape.
 *  Body truncated to 2000 chars (SMS gets segmented; email is
 *  rarely longer than this in our threads). */
export function coerceDraft(raw: unknown): SentinelDraft {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const option = coerceDraftOption(obj.option);
  const channel = option === "alert_only" ? "none" : coerceChannel(obj.channel);
  const bodyRaw = typeof obj.body === "string" ? obj.body.trim() : "";
  const body = channel === "none" ? "" : bodyRaw.slice(0, 2000);
  const subjectRaw = typeof obj.subject === "string" ? obj.subject.trim() : "";
  const subject =
    channel === "email" && subjectRaw.length > 0 ? subjectRaw.slice(0, 200) : undefined;
  return {
    option,
    label: OPTION_LABELS[option],
    channel,
    body,
    ...(subject ? { subject } : {}),
  };
}

/** Pure: coerce a model draft-list response into the canonical
 *  package shape. classification is always echoed verbatim (it's
 *  the input, not LLM output). */
export function coerceDraftPackage(
  raw: unknown,
  classification: SentinelClassification,
  model: string = SENTINEL_MODEL,
  now: () => Date = () => new Date(),
): SentinelDraftPackage {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = Array.isArray(obj.drafts)
    ? obj.drafts
    : Array.isArray(raw)
      ? raw
      : [];
  let drafts: SentinelDraft[] = arr.map(coerceDraft);

  // Filter out drafts whose option doesn't fit the intent — protects
  // against the model returning, e.g., "firm_hold" for a rejection.
  const allowed = new Set(optionsForIntent(classification.intent));
  if (allowed.size > 0) {
    drafts = drafts.filter((d) => allowed.has(d.option));
    // Dedupe by option — keep first occurrence.
    const seen = new Set<SentinelDraftOption>();
    drafts = drafts.filter((d) => {
      if (seen.has(d.option)) return false;
      seen.add(d.option);
      return true;
    });
  } else {
    // alert_only intent — drop everything.
    drafts = [];
  }

  // Coerce recommended_index into bounds. 0 when drafts present, 0
  // (degenerate, never read) when empty.
  let rec = typeof obj.recommended_index === "number" ? Math.floor(obj.recommended_index) : 0;
  if (drafts.length === 0) rec = 0;
  else if (rec < 0 || rec >= drafts.length) rec = 0;

  return {
    drafts,
    recommended_index: rec,
    classification,
    model,
    generated_at: now().toISOString(),
  };
}

const SENTINEL_DRAFTER_SYSTEM_PROMPT = `You are Sentinel, the inbound-reply drafter for AKB Solutions. The classifier has already triaged a single inbound; your job is to compose 1-3 short proposed reply options.

VOICE & POSTURE:
- Operator (Alex) is a wholesaler in TX / TN / MI. Voice is direct, agent-respectful, never apologetic. No "this is Alex with AKB Solutions" intros — assume mid-thread, the agent already knows us.
- Channel default = SMS. Switch to email ONLY when the reply needs multiple paragraphs, attachments, or formal terms.
- SMS bodies: ≤2 sentences, ≤200 chars. Use specific dollar amounts and dates when possible. Avoid filler. No emojis.
- Email bodies: still tight (≤6 sentences). Include subject when channel=email.

OPTION SEMANTICS (use the option ID exactly):
- firm_hold: Reassert our number; stand firm on price. ("$X is what works for us — happy to close fast on it.")
- soft_counter: Acknowledge their position, move modestly. ("$Y is the highest we can stretch given rehab — can you talk to seller?")
- ask_for_pof: Request proof-of-funds, entity, or end-buyer info before engaging further on price.
- soft_nurture: Keep the door open without committing to price movement. Use for lukewarm replies. ("Let me know when the seller's ready to move — I'll keep the deal warm.")
- answer_question: Direct factual answer to a specific question. Be precise — entity name, end-buyer disclosure, closing timeline, POF source.
- decline_politely: Polite walk-away for rejections. One sentence. Preserves relationship for future deals.

OUTPUT SHAPE — JSON array (no prose, no markdown fences):
[
  {
    "option": "<option_id>",
    "channel": "sms" | "email" | "none",
    "body": "<ready-to-send body>",
    "subject": "<optional, only for email>"
  },
  ...
]

DO NOT include alert_only — the calling code handles that path.
DO NOT reintroduce yourself.
DO NOT use the cold script for depth>=1 threads (you can assume mid-thread).
DO NOT speculate on numbers you don't have (e.g., never invent an ARV or rehab figure).`;

interface CallAnthropicArgs {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTokens?: number;
}

async function callAnthropicDefault(args: CallAnthropicArgs): Promise<string> {
  // Phase 10 / P.2 migration — routed through the unified synthesizer.
  // Phase 10.6 cache audit — drafter system prompt is stable across
  // invocations; cache_system: true unlocks Anthropic's prompt-cache
  // pricing on repeat draft calls.
  const result = await synthesize({
    agent: "sentinel",
    system: args.systemPrompt,
    user: args.userPrompt,
    max_tokens: args.maxTokens ?? 1024,
    apiKey: args.apiKey,
    event_label: "sentinel_drafted",
    cache_system: true,
  });
  return result.text;
}

function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

/** Pure: assemble the drafter user prompt. Mirrors the classifier's
 *  prompt shape — listing context + recent timeline + the inbound
 *  body + the classification verdict. */
export function buildDrafterUserPrompt(
  input: SentinelClassifierInput,
  classification: SentinelClassification,
): string {
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
  const optionsToGenerate = optionsForIntent(classification.intent);

  return `INBOUND REPLY (from agent):
"""
${input.body}
"""

Listing context:
Address: ${input.listing.address}${listPriceLine}${stateLine}
Agent: ${input.agent.name ?? "—"}${timeline}

Classification verdict (from Sentinel classifier):
- intent: ${classification.intent}
- confidence: ${classification.confidence.toFixed(2)}
- reasoning: ${classification.reasoning || "(no reasoning provided)"}
${classification.red_flags.length > 0 ? `- red_flags: ${classification.red_flags.join(", ")}` : ""}

Compose drafts for these option IDs ONLY: ${optionsToGenerate.join(", ") || "(none — alert only)"}.
JSON array only. No prose, no fences.`;
}

export interface DraftRepliesOpts {
  model?: string;
  callAnthropic?: (args: CallAnthropicArgs) => Promise<string>;
  now?: () => Date;
}

/** Compose Sentinel reply drafts for a classified inbound. Returns
 *  a SentinelDraftPackage with 0-3 drafts depending on intent. The
 *  alert_only path returns drafts: [] immediately without an LLM
 *  call — saves budget on wire-fraud / off-topic / spam intents. */
export async function draftRepliesFor(
  input: SentinelClassifierInput,
  classification: SentinelClassification,
  opts: DraftRepliesOpts = {},
): Promise<SentinelDraftPackage> {
  const model = opts.model ?? SENTINEL_MODEL;
  const now = opts.now ?? (() => new Date());
  const optionsToGenerate = optionsForIntent(classification.intent);

  // Short-circuit: no drafts to generate → skip the LLM call.
  if (optionsToGenerate.length === 0) {
    return {
      drafts: [],
      recommended_index: 0,
      classification,
      model,
      generated_at: now().toISOString(),
    };
  }

  const fetcher = opts.callAnthropic ?? callAnthropicDefault;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!opts.callAnthropic && !apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set — Sentinel drafter cannot run");
  }

  const userPrompt = buildDrafterUserPrompt(input, classification);
  const rawText = await fetcher({
    apiKey,
    systemPrompt: SENTINEL_DRAFTER_SYSTEM_PROMPT,
    userPrompt,
    model,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(rawText));
  } catch {
    parsed = [];
  }

  return coerceDraftPackage(parsed, classification, model, opts.now);
}
