// Phase 10 / P.1 — synthesizer smoke tests.
//
// Locks the synthesizer's destructive boundary: model resolution
// from registry, audit-log emission per call, error path, disabled-
// agent guard. Per-agent voice-consistency snapshots land in P.3.

import { describe, it, expect, vi } from "vitest";
import { extractText, modelMatches, synthesize } from "./synthesizer";
import { getVoiceEntry, VOICE_REGISTRY } from "./voice-registry";

describe("voice-registry", () => {
  it("has one entry per VoiceAgent in the union", () => {
    // Type-level enumeration: any agent in the union must have a
    // registry entry. Compiler enforces it via Record<VoiceAgent>,
    // but assert at runtime for clarity.
    const agents: Array<keyof typeof VOICE_REGISTRY> = [
      "maverick",
      "briefing",
      "shepherd",
      "crier",
      "appraiser",
      "scribe",
      "sentinel",
      "scout",
      "forge",
      "sentry",
      "pulse",
      "ledger",
      "agent_context",
    ];
    for (const a of agents) {
      expect(VOICE_REGISTRY[a]).toBeDefined();
      expect(VOICE_REGISTRY[a].agent).toBe(a);
      expect(VOICE_REGISTRY[a].model).toMatch(/^claude-/);
      expect(VOICE_REGISTRY[a].max_tokens).toBeGreaterThan(0);
      expect(VOICE_REGISTRY[a].voice_fragment).toBeTruthy();
    }
  });

  it("getVoiceEntry throws on disabled agent (forge ENABLED 2026-07-12 for reply drafting)", () => {
    expect(() => getVoiceEntry("shepherd")).toThrow(/disabled/);
    expect(() => getVoiceEntry("pulse")).toThrow(/disabled/);
    expect(() => getVoiceEntry("scribe")).toThrow(/disabled/);
    expect(() => getVoiceEntry("forge")).not.toThrow();
    expect(() => getVoiceEntry("sentry")).toThrow(/disabled/);
    expect(() => getVoiceEntry("ledger")).toThrow(/disabled/);
  });

  it("getVoiceEntry returns active entries cleanly", () => {
    expect(getVoiceEntry("maverick").model).toMatch(/^claude-/);
    expect(getVoiceEntry("appraiser").model).toMatch(/^claude-/);
    expect(getVoiceEntry("sentinel").model).toMatch(/^claude-/);
    expect(getVoiceEntry("crier").model).toMatch(/^claude-/);
    expect(getVoiceEntry("briefing").model).toMatch(/^claude-/);
    expect(getVoiceEntry("scout").model).toMatch(/^claude-/);
    expect(getVoiceEntry("agent_context").model).toMatch(/^claude-/);
  });
});

describe("extractText", () => {
  it("joins text blocks", () => {
    expect(
      extractText({
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      }),
    ).toBe("hello world");
  });

  it("ignores non-text blocks", () => {
    expect(
      extractText({
        content: [
          { type: "tool_use" },
          { type: "text", text: "kept" },
        ],
      }),
    ).toBe("kept");
  });

  it("returns empty string when content is missing", () => {
    expect(extractText({})).toBe("");
  });
});

describe("modelMatches", () => {
  const entry = VOICE_REGISTRY.maverick;

  it("returns true when actual matches registry", () => {
    expect(modelMatches(entry, entry.model)).toBe(true);
  });

  it("returns false when actual differs", () => {
    expect(modelMatches(entry, "claude-opus-some-fallback")).toBe(false);
  });

  it("returns true when actual is undefined (no info)", () => {
    expect(modelMatches(entry, undefined)).toBe(true);
  });
});

describe("synthesize", () => {
  const baseArgs = {
    agent: "maverick" as const,
    system: "You are Maverick.",
    user: "hello",
    apiKey: "test-key",
  };

  it("passes the registry model into the fetcher", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ack" }],
      model: VOICE_REGISTRY.maverick.model,
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    const out = await synthesize(baseArgs, { callAnthropic: fetcher, writeAudit });
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ model: VOICE_REGISTRY.maverick.model }),
    );
    expect(out.text).toBe("ack");
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 1 });
  });

  it("writes an audit entry tagged with the agent", async () => {
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    await synthesize(
      { ...baseArgs, agent: "appraiser" },
      {
        callAnthropic: async () => ({
          content: [{ type: "text", text: "x" }],
          model: VOICE_REGISTRY.appraiser.model,
        }),
        writeAudit,
      },
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "appraiser",
        event: "appraiser_synthesized",
        status: "confirmed_success",
      }),
    );
  });

  it("audits failures with the same agent tag (Pulse can read it)", async () => {
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    await expect(
      synthesize(baseArgs, {
        callAnthropic: async () => {
          throw new Error("anthropic_500");
        },
        writeAudit,
      }),
    ).rejects.toThrow("anthropic_500");
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "maverick",
        status: "confirmed_failure",
      }),
    );
  });

  it("respects event_label override", async () => {
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    await synthesize(
      { ...baseArgs, event_label: "rehab_calibrated" },
      {
        callAnthropic: async () => ({
          content: [{ type: "text", text: "ok" }],
          model: VOICE_REGISTRY.maverick.model,
        }),
        writeAudit,
      },
    );
    expect(writeAudit.mock.calls[0][0].event).toBe("rehab_calibrated");
  });

  it("rejects synthesize() against disabled agents at call time", async () => {
    await expect(
      synthesize({ ...baseArgs, agent: "pulse" }, {
        callAnthropic: async () => ({ content: [] }),
        writeAudit: async () => {},
      }),
    ).rejects.toThrow(/disabled/);
  });

  it("captures model-drift in outputSummary (model_matches_registry: false)", async () => {
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    await synthesize(baseArgs, {
      callAnthropic: async () => ({
        content: [{ type: "text", text: "x" }],
        model: "claude-something-else-fallback", // Anthropic served a fallback model
      }),
      writeAudit,
    });
    const auditCall = writeAudit.mock.calls[0][0];
    expect(auditCall.outputSummary.model_matches_registry).toBe(false);
    expect(auditCall.outputSummary.actual_model).toBe("claude-something-else-fallback");
  });

  it("caller's max_tokens wins, registry default applies when caller omits", async () => {
    // Caller-specified value passes through verbatim — refactor charter
    // says don't change behavior, and some callers intentionally cap
    // tight (agent_context's 16-token one-word classifier).
    const fetcher = vi.fn().mockResolvedValue({ content: [] });
    await synthesize(
      { ...baseArgs, max_tokens: 100 },
      { callAnthropic: fetcher, writeAudit: async () => {} },
    );
    expect(fetcher.mock.calls[0][0].max_tokens).toBe(100);

    // No caller value → registry default applies.
    const fetcher2 = vi.fn().mockResolvedValue({ content: [] });
    await synthesize(baseArgs, { callAnthropic: fetcher2, writeAudit: async () => {} });
    expect(fetcher2.mock.calls[0][0].max_tokens).toBe(VOICE_REGISTRY.maverick.max_tokens);
  });
});
