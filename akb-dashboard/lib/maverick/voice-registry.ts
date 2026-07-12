// Phase 10 / P.1 — Voice registry.
//
// Single source of truth for every named-agent's model choice +
// voice metadata. The synthesizer (lib/maverick/synthesizer.ts) reads
// from this registry — caller passes `agent`, registry resolves the
// model. Migrations replace literal `model: "claude-sonnet-..."`
// strings at call sites with synthesize({ agent, ... }) so future
// model bumps happen in one place AND drift (Crier sounding like
// Appraiser, missing registry entry, etc.) becomes detectable.
//
// **Refactor charter:** This module documents existing behavior. It
// does NOT change prompts or behavior — those stay in the call sites
// for now. The voice_fragment field captures the Character Spec
// voice for each agent so P.3 tests can snapshot them and future
// drift triggers a test failure.

import type { RosterAgent } from "./write-state";

export type VoiceAgent =
  | RosterAgent
  | "briefing"
  | "shepherd"
  | "agent_context";

export interface VoiceEntry {
  /** The agent this voice belongs to. */
  agent: VoiceAgent;
  /** Canonical Anthropic model ID. The synthesizer passes this
   *  through to the API. One place to bump model versions. */
  model: string;
  /** Optional temperature override. Anthropic default is 1.0; the
   *  existing call sites don't set temperature, so we leave it
   *  undefined to preserve behavior. */
  temperature?: number;
  /** Default max_tokens for this agent's responses. Synthesizer
   *  uses this as the floor; callers can pass a higher value. */
  max_tokens: number;
  /** Character Spec voice fragment — one paragraph capturing how
   *  this agent SHOULD sound. Locked by P.3 snapshot tests; future
   *  drift = test failure. Used by the synthesizer for audit-trail
   *  metadata, not appended to prompts (refactor charter). */
  voice_fragment: string;
  /** Short description for UI / audit-log readability. */
  description: string;
  /** True when the agent ships no LLM call today. Pulse + shepherd
   *  fall into this bucket. Registry entry kept for vocabulary
   *  completeness; synthesizer rejects calls to disabled entries. */
  disabled?: true;
}

// ── Canonical Anthropic model identifiers ─────────────────────────────────
//
// Locked here so the registry never carries free-form strings. Each
// constant maps to a specific Anthropic model release; bumping a
// constant updates every agent that references it in one change.
//
// Maverick context: these are the models in production as of 2026-05-18.
// Future model bumps update only this section.

export const MODEL_SONNET_4_6 = "claude-sonnet-4-6";
// 2026-06-29 ROOT-CAUSE FIX: Anthropic retired the dated Sonnet IDs. The legacy
// `claude-sonnet-4-20250514` 404'd in production (confirmed via Vercel runtime
// errors), silently killing every agent pinned to it — the morning brief
// (maverick) AND Crier, the agent that DRAFTS the outbound texts. Both stale
// aliases now resolve to the current 4.6 ID so nothing points at a dead model.
// (Appraiser was already on 4.6; if rehab-vision stays dark post-deploy its
// cause is separate — investigate the photo-scrape / route path.)
export const MODEL_SONNET_4_5 = MODEL_SONNET_4_6;
export const MODEL_SONNET_4_LEGACY = MODEL_SONNET_4_6;
export const MODEL_HAIKU_4_5 = "claude-haiku-4-5-20251001";

// ── Registry ──────────────────────────────────────────────────────────────

export const VOICE_REGISTRY: Record<VoiceAgent, VoiceEntry> = {
  maverick: {
    agent: "maverick",
    model: MODEL_SONNET_4_LEGACY,
    max_tokens: 2048,
    voice_fragment:
      "Owner's Rep voice. Plainspoken, direct, terse. Names things by their reality, not their euphemism. Does not editorialize. Does not perform optimism. Surfaces the facts that need eyes; lets Alex decide.",
    description: "Top-level conversational + chat surface (jarvis-chat).",
  },
  briefing: {
    agent: "briefing",
    model: MODEL_SONNET_4_6,
    max_tokens: 3000,
    voice_fragment:
      "Owner's Rep narrative voice — same character as Maverick, applied to the morning briefing. Synthesizes deterministic facts into a coherent picture without inventing data. Refers to deals by address, agents by name, dollars exactly. Confident silence when there's nothing to surface.",
    description: "Load-state narrative synthesizer (lib/maverick/synthesize.ts).",
  },
  shepherd: {
    agent: "shepherd",
    model: MODEL_SONNET_4_LEGACY,
    max_tokens: 1024,
    voice_fragment:
      "Daily UX Spec §3.1 — persistent panel UX voice. Status-bar-style. Single phrase per surface. No LLM calls today (rendered from structured briefing state); registry entry retained for vocabulary completeness.",
    description: "Persistent Shepherd panel (no LLM calls today).",
    disabled: true,
  },
  crier: {
    agent: "crier",
    model: MODEL_SONNET_4_LEGACY,
    max_tokens: 1024,
    voice_fragment:
      "SMS dispatcher voice. Drafts outbound texts that sound like a person, not a script. No buzzword openings. Specific numbers and dates. Mid-thread default — assumes the agent already knows AKB. Names the deal, makes the ask, stops.",
    description: "Outreach + reply-scan drafting (scan-comms).",
  },
  appraiser: {
    agent: "appraiser",
    model: MODEL_SONNET_4_6,
    max_tokens: 2048,
    voice_fragment:
      "Vision-analyst voice. Reports observed condition + structured BBC line items. Cites the photo, not the address. Never invents square footage or asking price. Marks confidence per item. Photo-vision + rehab-calibration use the same model; the system prompts differ by task.",
    description: "Photo vision + rehab calibration (lib/rehab-calibration).",
  },
  scribe: {
    agent: "scribe",
    model: MODEL_SONNET_4_6,
    max_tokens: 2048,
    voice_fragment:
      "Contracts voice. Cites paragraph numbers and clauses. Distinguishes redlines from missed terms. Surfaces operational gaps (EMD timing, signing-party identity) before stylistic issues. No LLM calls today — Path A DocuSign integration ships without one; registry entry held for when contract-review synthesis lands.",
    description: "DocuSign / contract review (no LLM calls today).",
    disabled: true,
  },
  sentinel: {
    agent: "sentinel",
    model: MODEL_SONNET_4_5,
    max_tokens: 1024,
    voice_fragment:
      "Inbound-reply triage voice. Conservative classification — when ambiguous, prefer lower intent / lower confidence. False-positive wire-fraud flags are cheap, missed scams are not. Drafter sub-voice: direct, agent-respectful, no cold-script reintros, SMS-default with email for multi-paragraph.",
    description: "Inbound classifier + reply drafter (lib/sentinel).",
  },
  scout: {
    agent: "scout",
    model: MODEL_SONNET_4_5,
    max_tokens: 1024,
    voice_fragment:
      "Buyer-pipeline voice. Drafts warmup-cadence emails + first-touch outreach to investors. Tone matches the buyer's prior depth — formal with InvestorBase pulls, warm with networking referrals. References specific deals when the matcher has them in hand.",
    description: "Buyer warmup + dispo outreach drafts (buyers/*).",
  },
  forge: {
    agent: "forge",
    model: MODEL_SONNET_4_5,
    max_tokens: 1024,
    voice_fragment:
      "Email-register drafting voice (RECOMMENDED REPLIES, 2026-07-12). Short professional emails — two brief paragraphs max, plain text, signed Alex Balog · AKB Solutions LLC. Answers the counterparty's actual question first, one clear next step last. Carries the delivery-stamped number verbatim or no number at all; costs are paid from proceeds at closing; title facts defer to the title company. Never acknowledges legal disclosures on the operator's behalf.",
    description: "Email reply drafting (recommended-replies 2A lane).",
  },
  sentry: {
    agent: "sentry",
    model: MODEL_SONNET_4_5,
    max_tokens: 1024,
    voice_fragment:
      "Gate-verification voice. Audit-style — reports which gates passed, which failed, with the specific input that triggered the failure. No LLM calls today; gates run pure-function. Registry held for the day Sentry needs to explain a gate decision in prose.",
    description: "Pre-outreach / pre-send / pre-negotiation gates (no LLM today).",
    disabled: true,
  },
  pulse: {
    agent: "pulse",
    model: MODEL_SONNET_4_5,
    max_tokens: 512,
    voice_fragment:
      "Self-monitoring voice — terse, factual, no alarm. Reports detection state in operator terms: what fired, what the source data shows, what the suggested action is. Never auto-remediates. Detectors are pure-function today; this entry is held for a future synthesized-summary path.",
    description: "Anomaly detection (no LLM calls today — pure detectors).",
    disabled: true,
  },
  ledger: {
    agent: "ledger",
    model: MODEL_SONNET_4_5,
    max_tokens: 1024,
    voice_fragment:
      "Economics voice. Reports revenue / costs / retirement-meter progress in dollars and weeks. Not yet shipping — held for Phase 15.",
    description: "Revenue + retirement meter (Phase 15, no LLM today).",
    disabled: true,
  },
  agent_context: {
    agent: "agent_context",
    model: MODEL_HAIKU_4_5,
    // Tone classifier task is intentionally tiny — one-word output.
    // Callers pass max_tokens: 16 explicitly; this default is the
    // safe fallback when a caller forgets.
    max_tokens: 64,
    voice_fragment:
      "Tone-classifier voice. Compact, deterministic output. No prose. Reads recent inbound/outbound bodies and emits depth_score + inferred_tone + isPrincipal flag. Haiku-tier because the task is small and the volume is high.",
    description: "Agent-context tone classifier (api/agent-context).",
  },
};

// ── Pure helpers ──────────────────────────────────────────────────────────

/** Pure: read a registry entry. Throws on missing OR disabled agent —
 *  the synthesizer relies on this to never invoke a disabled entry. */
export function getVoiceEntry(agent: VoiceAgent): VoiceEntry {
  const entry = VOICE_REGISTRY[agent];
  if (!entry) {
    throw new Error(`voice-registry: no entry for agent "${agent}"`);
  }
  if (entry.disabled) {
    throw new Error(
      `voice-registry: agent "${agent}" is registered but disabled (no LLM call expected). Migration left a call site pointing at it.`,
    );
  }
  return entry;
}

/** Pure: read a registry entry without the disabled guard. Used by
 *  the snapshot tests + audit surfaces that want to inspect disabled
 *  entries too. */
export function peekVoiceEntry(agent: VoiceAgent): VoiceEntry | null {
  return VOICE_REGISTRY[agent] ?? null;
}

/** Pure: enumerate every agent that has a live LLM call today.
 *  Disabled entries are excluded. Used by Pulse's drift detector. */
export function listActiveVoiceAgents(): VoiceAgent[] {
  return Object.entries(VOICE_REGISTRY)
    .filter(([, entry]) => !entry.disabled)
    .map(([agent]) => agent as VoiceAgent);
}
