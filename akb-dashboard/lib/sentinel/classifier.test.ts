// Phase 13 / N.1 — Sentinel classifier coercion tests.
//
// Locks the pure helpers that defend the classifier's output shape
// against malformed model responses. The Anthropic call itself is
// injectable via opts.callAnthropic — we exercise that path here too
// without touching the network.

import { describe, it, expect } from "vitest";
import {
  buildClassifierUserPrompt,
  classifyInboundReply,
  coerceClassification,
  coerceConfidence,
  coerceIntent,
  coerceMotivationScore,
  coerceReasoning,
  coerceRedFlags,
  SENTINEL_MODEL,
  stripJsonFences,
} from "./classifier";
import type { SentinelClassifierInput } from "./types";

describe("coerceIntent", () => {
  it("passes through canonical intents", () => {
    expect(coerceIntent("motivated")).toBe("motivated");
    expect(coerceIntent("lukewarm")).toBe("lukewarm");
    expect(coerceIntent("rejection")).toBe("rejection");
    expect(coerceIntent("question")).toBe("question");
    expect(coerceIntent("wire_fraud_red_flag")).toBe("wire_fraud_red_flag");
    expect(coerceIntent("off_topic")).toBe("off_topic");
    expect(coerceIntent("spam")).toBe("spam");
  });

  it("normalizes spaces / dashes to underscores", () => {
    expect(coerceIntent("wire fraud red flag")).toBe("wire_fraud_red_flag");
    expect(coerceIntent("wire-fraud-red-flag")).toBe("wire_fraud_red_flag");
    expect(coerceIntent("OFF TOPIC")).toBe("off_topic");
  });

  it("defaults unknown / non-string to off_topic (safe default)", () => {
    expect(coerceIntent("interested")).toBe("off_topic");
    expect(coerceIntent("")).toBe("off_topic");
    expect(coerceIntent(null)).toBe("off_topic");
    expect(coerceIntent(undefined)).toBe("off_topic");
    expect(coerceIntent(42)).toBe("off_topic");
    expect(coerceIntent({})).toBe("off_topic");
  });
});

describe("coerceConfidence", () => {
  it("passes through valid [0, 1] floats", () => {
    expect(coerceConfidence(0)).toBe(0);
    expect(coerceConfidence(0.5)).toBe(0.5);
    expect(coerceConfidence(1)).toBe(1);
  });

  it("clamps negatives to 0 and >1 (within 100) to /100", () => {
    expect(coerceConfidence(-1)).toBe(0);
    expect(coerceConfidence(85)).toBe(0.85); // model returned a percentage
    expect(coerceConfidence(100)).toBe(1);
  });

  it("clamps >100 to 1 (assume garbled)", () => {
    expect(coerceConfidence(150)).toBe(1);
    expect(coerceConfidence(99999)).toBe(1);
  });

  it("defaults non-finite / non-number to 0", () => {
    expect(coerceConfidence(NaN)).toBe(0);
    expect(coerceConfidence(Infinity)).toBe(0);
    expect(coerceConfidence("0.5")).toBe(0);
    expect(coerceConfidence(null)).toBe(0);
  });
});

describe("coerceRedFlags", () => {
  it("filters to known categories, drops unknowns silently", () => {
    expect(
      coerceRedFlags(["phishing_link", "totally_made_up", "request_wire_transfer"]),
    ).toEqual(["phishing_link", "request_wire_transfer"]);
  });

  it("normalizes spaces / dashes to underscores", () => {
    expect(coerceRedFlags(["phishing link", "FAKE-URGENCY"])).toEqual([
      "phishing_link",
      "fake_urgency",
    ]);
  });

  it("dedupes via Set", () => {
    expect(
      coerceRedFlags(["phishing_link", "phishing_link", "phishing-link"]),
    ).toEqual(["phishing_link"]);
  });

  it("returns [] for non-array / non-string entries", () => {
    expect(coerceRedFlags(null)).toEqual([]);
    expect(coerceRedFlags("phishing_link")).toEqual([]);
    expect(coerceRedFlags([42, null, true])).toEqual([]);
  });
});

describe("coerceMotivationScore", () => {
  it("clamps to integer 1-5 for motivated/lukewarm", () => {
    expect(coerceMotivationScore(4, "motivated")).toBe(4);
    expect(coerceMotivationScore(1, "lukewarm")).toBe(1);
    expect(coerceMotivationScore(5, "motivated")).toBe(5);
  });

  it("rounds floats to nearest integer", () => {
    expect(coerceMotivationScore(3.7, "motivated")).toBe(4);
    expect(coerceMotivationScore(2.4, "lukewarm")).toBe(2);
  });

  it("returns null for non-applicable intents", () => {
    expect(coerceMotivationScore(4, "rejection")).toBeNull();
    expect(coerceMotivationScore(4, "question")).toBeNull();
    expect(coerceMotivationScore(4, "wire_fraud_red_flag")).toBeNull();
    expect(coerceMotivationScore(4, "off_topic")).toBeNull();
    expect(coerceMotivationScore(4, "spam")).toBeNull();
  });

  it("returns null when out of range 1-5", () => {
    expect(coerceMotivationScore(0, "motivated")).toBeNull();
    expect(coerceMotivationScore(6, "motivated")).toBeNull();
    expect(coerceMotivationScore(-1, "motivated")).toBeNull();
  });

  it("returns null for non-number / non-finite", () => {
    expect(coerceMotivationScore(null, "motivated")).toBeNull();
    expect(coerceMotivationScore("4", "motivated")).toBeNull();
    expect(coerceMotivationScore(NaN, "motivated")).toBeNull();
  });
});

describe("coerceReasoning", () => {
  it("trims and passes through short strings", () => {
    expect(coerceReasoning("  Strong interest in price negotiation  ")).toBe(
      "Strong interest in price negotiation",
    );
  });

  it("truncates >500 chars with ellipsis", () => {
    const long = "a".repeat(600);
    const out = coerceReasoning(long);
    expect(out.length).toBe(500);
    expect(out.endsWith("...")).toBe(true);
  });

  it("returns empty string for non-string", () => {
    expect(coerceReasoning(null)).toBe("");
    expect(coerceReasoning(undefined)).toBe("");
    expect(coerceReasoning(42)).toBe("");
  });
});

describe("coerceClassification — full shape", () => {
  const fixedNow = () => new Date("2026-05-18T20:00:00Z");

  it("coerces a well-formed model response", () => {
    const raw = {
      intent: "motivated",
      confidence: 0.82,
      reasoning: "Agent gave a specific counter at $90K with a 30-day close.",
      red_flags: [],
      motivation_score_hint: 4,
    };
    const c = coerceClassification(raw, "claude-test", fixedNow);
    expect(c).toEqual({
      intent: "motivated",
      confidence: 0.82,
      reasoning: "Agent gave a specific counter at $90K with a 30-day close.",
      red_flags: [],
      motivation_score_hint: 4,
      model: "claude-test",
      classified_at: "2026-05-18T20:00:00.000Z",
    });
  });

  it("safely handles a totally empty model response", () => {
    const c = coerceClassification({}, "claude-test", fixedNow);
    expect(c.intent).toBe("off_topic");
    expect(c.confidence).toBe(0);
    expect(c.reasoning).toBe("");
    expect(c.red_flags).toEqual([]);
    expect(c.motivation_score_hint).toBeNull();
  });

  it("uses default SENTINEL_MODEL when none supplied", () => {
    const c = coerceClassification({ intent: "rejection" });
    expect(c.model).toBe(SENTINEL_MODEL);
  });

  it("nulls motivation_score when intent is non-motivated even if model provided one", () => {
    const c = coerceClassification(
      { intent: "rejection", motivation_score_hint: 3 },
      "claude-test",
      fixedNow,
    );
    expect(c.motivation_score_hint).toBeNull();
  });

  it("filters unknown red_flags out of the final shape", () => {
    const c = coerceClassification(
      {
        intent: "wire_fraud_red_flag",
        red_flags: ["phishing_link", "made_up_flag", "request_wire_transfer"],
      },
      "claude-test",
      fixedNow,
    );
    expect(c.red_flags).toEqual(["phishing_link", "request_wire_transfer"]);
  });
});

describe("buildClassifierUserPrompt", () => {
  const baseInput: SentinelClassifierInput = {
    body: "yes, send me your best offer",
    listing: {
      address: "1219 E Highland Blvd",
      list_price: 163000,
      state: "TX",
    },
    agent: { name: "Jane Smith" },
  };

  it("includes the reply body wrapped in triple-quotes", () => {
    const p = buildClassifierUserPrompt(baseInput);
    expect(p).toContain(`"""\nyes, send me your best offer\n"""`);
  });

  it("includes listing address + formatted list price + state when present", () => {
    const p = buildClassifierUserPrompt(baseInput);
    expect(p).toContain("Address: 1219 E Highland Blvd");
    expect(p).toContain("List price: $163,000");
    expect(p).toContain("State: TX");
  });

  it("omits list price + state lines when null", () => {
    const p = buildClassifierUserPrompt({
      ...baseInput,
      listing: { address: "X", list_price: null, state: null },
    });
    expect(p).not.toContain("List price:");
    expect(p).not.toContain("State:");
  });

  it("renders recent timeline when supplied", () => {
    const p = buildClassifierUserPrompt({
      ...baseInput,
      recent_timeline_snippets: ["[us] hi from us", "[agent] earlier reply"],
    });
    expect(p).toContain("Recent timeline");
    expect(p).toContain("1. [us] hi from us");
    expect(p).toContain("2. [agent] earlier reply");
  });

  it("omits the timeline section when empty", () => {
    const p = buildClassifierUserPrompt({
      ...baseInput,
      recent_timeline_snippets: [],
    });
    expect(p).not.toContain("Recent timeline");
  });

  it("agent name falls back to em-dash when null", () => {
    const p = buildClassifierUserPrompt({
      ...baseInput,
      agent: { name: null },
    });
    expect(p).toContain("Agent: —");
  });
});

describe("stripJsonFences", () => {
  it("strips ```json fences", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips bare ``` fences", () => {
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves un-fenced JSON alone", () => {
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
  });

  it("trims surrounding whitespace", () => {
    expect(stripJsonFences('   {"a":1}   ')).toBe('{"a":1}');
  });
});

describe("classifyInboundReply (injected fetcher)", () => {
  const input: SentinelClassifierInput = {
    body: "we're firm at list, not interested",
    listing: { address: "X", list_price: 100000, state: "TX" },
    agent: { name: "Agent A" },
  };

  it("parses a valid model JSON response and coerces", async () => {
    const out = await classifyInboundReply(input, {
      model: "claude-test",
      now: () => new Date("2026-05-18T20:00:00Z"),
      callAnthropic: async () =>
        JSON.stringify({
          intent: "rejection",
          confidence: 0.92,
          reasoning: "Explicit firm-at-list + not-interested signal.",
          red_flags: [],
          motivation_score_hint: null,
        }),
    });
    expect(out.intent).toBe("rejection");
    expect(out.confidence).toBe(0.92);
    expect(out.classified_at).toBe("2026-05-18T20:00:00.000Z");
    expect(out.model).toBe("claude-test");
  });

  it("safely handles a fenced JSON response", async () => {
    const out = await classifyInboundReply(input, {
      model: "claude-test",
      callAnthropic: async () =>
        '```json\n{"intent":"motivated","confidence":0.7,"motivation_score_hint":4}\n```',
    });
    expect(out.intent).toBe("motivated");
    expect(out.motivation_score_hint).toBe(4);
  });

  it("falls through to safe defaults when model returns garbage", async () => {
    const out = await classifyInboundReply(input, {
      model: "claude-test",
      callAnthropic: async () => "this is not json at all",
    });
    expect(out.intent).toBe("off_topic");
    expect(out.confidence).toBe(0);
    expect(out.red_flags).toEqual([]);
  });

  it("propagates fetcher errors", async () => {
    await expect(
      classifyInboundReply(input, {
        model: "claude-test",
        callAnthropic: async () => {
          throw new Error("anthropic_429");
        },
      }),
    ).rejects.toThrow("anthropic_429");
  });
});
