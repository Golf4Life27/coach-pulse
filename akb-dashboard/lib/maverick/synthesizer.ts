// Phase 10 / P.1 — Unified LLM synthesizer.
//
// Single entry point for every agent's Claude API call. Replaces
// scattered `fetch("https://api.anthropic.com/v1/messages", ...)` +
// hardcoded `model: "claude-sonnet-..."` literals across the codebase.
//
// Why this exists:
//   1. Model bumps land in one place (voice-registry.ts) instead of
//      ~10 scattered call sites.
//   2. Voice drift becomes detectable — Pulse can compare actual
//      invocations against the registry (P.4 detector class).
//   3. Audit trail captures `agent` per call so token-burn + per-
//      agent cost attribution work downstream.
//
// Refactor charter (per Alex's brief): "Don't change agent prompts
// or behavior — this is a refactor, not a voice redesign." The
// synthesizer passes through system + user prompts as the caller
// provides them. The registry locks the model only.

import { audit } from "@/lib/audit-log";
import {
  getVoiceEntry,
  type VoiceAgent,
  type VoiceEntry,
} from "./voice-registry";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

/** Anthropic Messages API content block (text-only for now;
 *  multi-modal vision callers extend the user message inline). */
export type AnthropicContent =
  | string
  | Array<{ type: string; text?: string; source?: unknown }>;

export interface SynthesizeArgs {
  /** Roster name. Resolves to a model + voice via voice-registry. */
  agent: VoiceAgent;
  /** Caller-supplied system prompt. Passed through verbatim — the
   *  registry does NOT modify or prepend (refactor charter). */
  system: string;
  /** User message content. String or Anthropic content-block array
   *  (the latter for vision calls). */
  user: AnthropicContent;
  /** Override the registry's default max_tokens (must be at least the
   *  registry default for the call to proceed; the registry default
   *  is the floor). */
  max_tokens?: number;
  /** Override the registry's temperature. */
  temperature?: number;
  /** Tag the audit-log entry. Optional — defaults to "<agent>_synthesized". */
  event_label?: string;
  /** Caller can pass recordId to thread through to the audit trail. */
  recordId?: string;
  /** Anthropic API key (defaults to process.env.ANTHROPIC_API_KEY). */
  apiKey?: string;
}

export interface SynthesizeResult {
  /** Concatenated text content from the response (text blocks joined). */
  text: string;
  /** The model that ran. Echoed for caller-side logging + Pulse drift. */
  model: string;
  /** Stop reason from Anthropic. */
  stop_reason: string | null;
  /** Approximate input + output token counts (Anthropic surfaces these
   *  on every response). Drives Pulse token-burn detection downstream. */
  usage: {
    input_tokens: number;
    output_tokens: number;
  } | null;
  /** Round-trip latency. */
  elapsed_ms: number;
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface SynthesizerDeps {
  /** Injectable fetcher for tests. Defaults to the live Anthropic call. */
  callAnthropic?: (args: {
    apiKey: string;
    model: string;
    system: string;
    user: AnthropicContent;
    max_tokens: number;
    temperature?: number;
  }) => Promise<AnthropicResponse>;
  /** Injectable audit fn for tests. Defaults to lib/audit-log.audit. */
  writeAudit?: typeof audit;
}

async function callAnthropicDefault(args: {
  apiKey: string;
  model: string;
  system: string;
  user: AnthropicContent;
  max_tokens: number;
  temperature?: number;
}): Promise<AnthropicResponse> {
  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: args.max_tokens,
    system: args.system,
    messages: [
      {
        role: "user",
        content: args.user,
      },
    ],
  };
  if (args.temperature !== undefined) body.temperature = args.temperature;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as AnthropicResponse;
}

/** Pure: extract the joined text content from an Anthropic response. */
export function extractText(response: AnthropicResponse): string {
  if (!Array.isArray(response.content)) return "";
  return response.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("");
}

/** Pure: validate that a registry entry's model matches the actual
 *  model that ran. Used by P.4 Pulse drift detector to catch the
 *  case where Anthropic served a different model (quota fallback,
 *  etc.) than the registry specifies. */
export function modelMatches(entry: VoiceEntry, actualModel: string | undefined): boolean {
  if (!actualModel) return true; // no info → assume match
  return actualModel === entry.model;
}

/**
 * Synthesize a Claude response for `agent`. Resolves model + voice
 * metadata from voice-registry. Writes an audit entry tagged with
 * the agent for downstream cost + drift accounting.
 *
 * Throws when ANTHROPIC_API_KEY is missing and no injected fetcher,
 * or when the agent is registered but disabled.
 */
export async function synthesize(
  args: SynthesizeArgs,
  deps: SynthesizerDeps = {},
): Promise<SynthesizeResult> {
  const t0 = Date.now();
  const entry = getVoiceEntry(args.agent);
  const apiKey = args.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  if (!deps.callAnthropic && !apiKey) {
    throw new Error(`synthesizer: ANTHROPIC_API_KEY missing for agent "${args.agent}"`);
  }
  const fetcher = deps.callAnthropic ?? callAnthropicDefault;
  const writeAudit = deps.writeAudit ?? audit;

  const maxTokens = Math.max(args.max_tokens ?? entry.max_tokens, entry.max_tokens);
  const temperature = args.temperature ?? entry.temperature;

  let response: AnthropicResponse;
  let error: string | null = null;
  try {
    response = await fetcher({
      apiKey,
      model: entry.model,
      system: args.system,
      user: args.user,
      max_tokens: maxTokens,
      temperature,
    });
  } catch (err) {
    error = String(err).slice(0, 500);
    // Audit the failure before re-throwing so token-burn / endpoint-
    // error-rate detectors see it.
    await writeAudit({
      agent: args.agent,
      event: args.event_label ?? `${args.agent}_synthesized`,
      status: "confirmed_failure",
      recordId: args.recordId,
      inputSummary: {
        model: entry.model,
        max_tokens: maxTokens,
        system_length: args.system.length,
      },
      outputSummary: { error },
      decision: "error",
      ms: Date.now() - t0,
    });
    throw err;
  }

  const text = extractText(response);
  const elapsed_ms = Date.now() - t0;
  const actualModel = response.model ?? entry.model;
  const usage =
    response.usage && typeof response.usage.input_tokens === "number" && typeof response.usage.output_tokens === "number"
      ? {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        }
      : null;

  // Per-synthesis audit. Captures the agent + model + token counts so
  // Pulse's token-burn detector + future drift detector can read off
  // the audit log without re-running synthesis.
  await writeAudit({
    agent: args.agent,
    event: args.event_label ?? `${args.agent}_synthesized`,
    status: "confirmed_success",
    recordId: args.recordId,
    inputSummary: {
      model: entry.model,
      max_tokens: maxTokens,
      system_length: args.system.length,
    },
    outputSummary: {
      actual_model: actualModel,
      stop_reason: response.stop_reason ?? null,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      response_length: text.length,
      model_matches_registry: modelMatches(entry, response.model),
    },
    decision: "ok",
    ms: elapsed_ms,
  });

  return {
    text,
    model: actualModel,
    stop_reason: response.stop_reason ?? null,
    usage,
    elapsed_ms,
  };
}
