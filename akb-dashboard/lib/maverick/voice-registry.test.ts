// Phase 10 / P.3 — Voice consistency snapshots.
//
// Locks each agent's model choice + voice fragment so future drift
// triggers a test failure. The brief's framing: "Future drift = test
// failure." If an agent's voice fragment changes, this test fails,
// the operator either approves the new voice (updating the snapshot)
// or reverts the change.
//
// Posture per vitest.config: pure-function tests only. Voice
// fragments + model IDs are inline strings — no fixtures needed.

import { describe, it, expect } from "vitest";
import {
  VOICE_REGISTRY,
  MODEL_SONNET_4_6,
  MODEL_SONNET_4_5,
  MODEL_SONNET_4_LEGACY,
  MODEL_HAIKU_4_5,
  listActiveVoiceAgents,
  peekVoiceEntry,
  type VoiceAgent,
} from "./voice-registry";

describe("voice-registry — model lockdown", () => {
  // Locks model choice per agent. A Pulse drift event would fire when
  // any agent's actual call ran with a different model than the
  // registry — but the FIRST defense is this test failing at PR time.

  it("maverick → Sonnet 4 legacy", () => {
    expect(VOICE_REGISTRY.maverick.model).toBe(MODEL_SONNET_4_LEGACY);
  });

  it("briefing → Sonnet 4.6", () => {
    expect(VOICE_REGISTRY.briefing.model).toBe(MODEL_SONNET_4_6);
  });

  it("shepherd → Sonnet 4 legacy (disabled, registry-only)", () => {
    expect(VOICE_REGISTRY.shepherd.model).toBe(MODEL_SONNET_4_LEGACY);
    expect(VOICE_REGISTRY.shepherd.disabled).toBe(true);
  });

  it("crier → Sonnet 4 legacy", () => {
    expect(VOICE_REGISTRY.crier.model).toBe(MODEL_SONNET_4_LEGACY);
  });

  it("appraiser → Sonnet 4.6 (vision)", () => {
    expect(VOICE_REGISTRY.appraiser.model).toBe(MODEL_SONNET_4_6);
  });

  it("scribe → Sonnet 4.6 (disabled, no LLM today)", () => {
    expect(VOICE_REGISTRY.scribe.model).toBe(MODEL_SONNET_4_6);
    expect(VOICE_REGISTRY.scribe.disabled).toBe(true);
  });

  it("sentinel → Sonnet 4.5", () => {
    expect(VOICE_REGISTRY.sentinel.model).toBe(MODEL_SONNET_4_5);
  });

  it("scout → Sonnet 4.5", () => {
    expect(VOICE_REGISTRY.scout.model).toBe(MODEL_SONNET_4_5);
  });

  it("forge → Sonnet 4.5 (ENABLED 2026-07-12: email register for recommended replies)", () => {
    expect(VOICE_REGISTRY.forge.model).toBe(MODEL_SONNET_4_5);
    expect(VOICE_REGISTRY.forge.disabled).toBeUndefined();
    expect(VOICE_REGISTRY.forge.voice_fragment).toContain("stamped number verbatim or no number at all");
  });

  it("sentry → Sonnet 4.5 (disabled, gates run pure)", () => {
    expect(VOICE_REGISTRY.sentry.model).toBe(MODEL_SONNET_4_5);
    expect(VOICE_REGISTRY.sentry.disabled).toBe(true);
  });

  it("pulse → Sonnet 4.5 (disabled, detectors are pure)", () => {
    expect(VOICE_REGISTRY.pulse.model).toBe(MODEL_SONNET_4_5);
    expect(VOICE_REGISTRY.pulse.disabled).toBe(true);
  });

  it("ledger → Sonnet 4.5 (disabled, Phase 15)", () => {
    expect(VOICE_REGISTRY.ledger.model).toBe(MODEL_SONNET_4_5);
    expect(VOICE_REGISTRY.ledger.disabled).toBe(true);
  });

  it("agent_context → Haiku 4.5 (tone classifier)", () => {
    expect(VOICE_REGISTRY.agent_context.model).toBe(MODEL_HAIKU_4_5);
  });
});

describe("voice-registry — voice fragment snapshots", () => {
  // Snapshots the Character Spec voice fragment per agent. These are
  // INLINE STRINGS in the test (not file snapshots) so a diff is
  // surfaced verbatim in code review. If you intentionally change a
  // voice fragment, update both the registry and this test together —
  // forcing the operator to acknowledge the voice change.

  it("maverick voice = Owner's Rep, terse, surfaces facts", () => {
    expect(VOICE_REGISTRY.maverick.voice_fragment).toBe(
      "Owner's Rep voice. Plainspoken, direct, terse. Names things by their reality, not their euphemism. Does not editorialize. Does not perform optimism. Surfaces the facts that need eyes; lets Alex decide.",
    );
  });

  it("briefing voice = Maverick voice in narrative prose", () => {
    expect(VOICE_REGISTRY.briefing.voice_fragment).toMatch(/Owner's Rep narrative voice/);
    expect(VOICE_REGISTRY.briefing.voice_fragment).toMatch(/Maverick/);
    expect(VOICE_REGISTRY.briefing.voice_fragment).toMatch(/deals? by address/i);
  });

  it("crier voice = SMS dispatcher, mid-thread default", () => {
    expect(VOICE_REGISTRY.crier.voice_fragment).toMatch(/SMS dispatcher/);
    expect(VOICE_REGISTRY.crier.voice_fragment).toMatch(/[Mm]id-thread default/);
    expect(VOICE_REGISTRY.crier.voice_fragment).not.toMatch(/Owner's Rep/);
  });

  it("appraiser voice = vision-analyst, photo-cited", () => {
    expect(VOICE_REGISTRY.appraiser.voice_fragment).toMatch(/[Vv]ision-analyst/);
    expect(VOICE_REGISTRY.appraiser.voice_fragment).toMatch(/photo/);
    expect(VOICE_REGISTRY.appraiser.voice_fragment).toMatch(/Marks confidence/);
  });

  it("sentinel voice = conservative classification + agent-respectful drafter", () => {
    expect(VOICE_REGISTRY.sentinel.voice_fragment).toMatch(/[Cc]onservative classification/);
    expect(VOICE_REGISTRY.sentinel.voice_fragment).toMatch(/wire-fraud/);
    expect(VOICE_REGISTRY.sentinel.voice_fragment).toMatch(/agent-respectful/);
  });

  it("scout voice = buyer-pipeline, matches buyer's depth", () => {
    expect(VOICE_REGISTRY.scout.voice_fragment).toMatch(/[Bb]uyer-pipeline/);
    expect(VOICE_REGISTRY.scout.voice_fragment).toMatch(/buyer's prior depth/i);
  });

  it("agent_context voice = compact deterministic classifier", () => {
    expect(VOICE_REGISTRY.agent_context.voice_fragment).toMatch(/[Tt]one-classifier/);
    expect(VOICE_REGISTRY.agent_context.voice_fragment).toMatch(/deterministic output/i);
    expect(VOICE_REGISTRY.agent_context.voice_fragment).toMatch(/Haiku-tier/);
  });

  it("voice fragments are not duplicated across agents (no drift signature)", () => {
    // The Phase 14 drift class: "Crier sounding like Appraiser". If
    // two agents share the same voice fragment verbatim, that's
    // exactly that drift in the registry — fail.
    const fragments = Object.values(VOICE_REGISTRY).map((e) => e.voice_fragment);
    const unique = new Set(fragments);
    expect(unique.size).toBe(fragments.length);
  });
});

describe("voice-registry — completeness invariants", () => {
  it("every entry has the required fields", () => {
    for (const [agent, entry] of Object.entries(VOICE_REGISTRY)) {
      expect(entry.agent).toBe(agent);
      expect(entry.model).toMatch(/^claude-/);
      expect(entry.max_tokens).toBeGreaterThan(0);
      expect(entry.voice_fragment.length).toBeGreaterThan(50);
      expect(entry.description.length).toBeGreaterThan(10);
    }
  });

  it("active agents (LLM today) — 8 entries (forge enabled 2026-07-12)", () => {
    expect(listActiveVoiceAgents().sort()).toEqual([
      "agent_context",
      "appraiser",
      "briefing",
      "crier",
      "forge",
      "maverick",
      "scout",
      "sentinel",
    ]);
  });

  it("disabled agents (registry held for future) — 5 entries (forge enabled 2026-07-12)", () => {
    const disabled = Object.entries(VOICE_REGISTRY)
      .filter(([, e]) => e.disabled)
      .map(([a]) => a as VoiceAgent)
      .sort();
    expect(disabled).toEqual([
      "ledger",
      "pulse",
      "scribe",
      "sentry",
      "shepherd",
    ]);
  });

  it("peekVoiceEntry returns entry without disabled guard", () => {
    // For audit surfaces that need to inspect disabled entries too.
    expect(peekVoiceEntry("pulse")?.disabled).toBe(true);
    expect(peekVoiceEntry("maverick")?.disabled).toBeUndefined();
  });

  it("peekVoiceEntry returns null for unknown agents", () => {
    expect(peekVoiceEntry("nonexistent" as VoiceAgent)).toBeNull();
  });
});

describe("voice-registry — max_tokens budgets (per-task expectations)", () => {
  // Different tasks have different budget needs. Lock them so a
  // future caller can't accidentally cap a long-form drafter at
  // chat-size, or blow up a one-word classifier with a 2K budget.

  it("agent_context tone classifier — small budget (≤128)", () => {
    expect(VOICE_REGISTRY.agent_context.max_tokens).toBeLessThanOrEqual(128);
  });

  it("pulse / shepherd / sentry — small (≤1024)", () => {
    expect(VOICE_REGISTRY.pulse.max_tokens).toBeLessThanOrEqual(1024);
    expect(VOICE_REGISTRY.shepherd.max_tokens).toBeLessThanOrEqual(1024);
    expect(VOICE_REGISTRY.sentry.max_tokens).toBeLessThanOrEqual(1024);
  });

  it("maverick + briefing + appraiser — multi-paragraph (≥2048)", () => {
    expect(VOICE_REGISTRY.maverick.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(VOICE_REGISTRY.briefing.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(VOICE_REGISTRY.appraiser.max_tokens).toBeGreaterThanOrEqual(2048);
  });
});
