// Phase 13 / N.2 — Sentinel drafter coercion + dispatch tests.
//
// Locks the pure helpers behind the drafter: option-per-intent
// mapping, coerceDraft / coerceDraftPackage shape defenses, and the
// alert-only short-circuit that skips the LLM call for wire-fraud /
// off-topic / spam intents. Drafter LLM call is exercised via the
// injectable fetcher.

import { describe, it, expect } from "vitest";
import {
  buildDrafterUserPrompt,
  coerceChannel,
  coerceDraft,
  coerceDraftOption,
  coerceDraftPackage,
  draftRepliesFor,
  optionsForIntent,
} from "./drafter";
import type {
  SentinelClassification,
  SentinelClassifierInput,
} from "./types";

const fixedNow = () => new Date("2026-05-18T20:00:00Z");

function mkClassification(
  intent: SentinelClassification["intent"],
  overrides: Partial<SentinelClassification> = {},
): SentinelClassification {
  return {
    intent,
    confidence: 0.8,
    reasoning: "test",
    red_flags: [],
    motivation_score_hint: intent === "motivated" || intent === "lukewarm" ? 3 : null,
    model: "claude-test",
    classified_at: "2026-05-18T20:00:00.000Z",
    ...overrides,
  };
}

describe("optionsForIntent", () => {
  it("motivated → firm_hold + soft_counter + ask_for_pof", () => {
    expect(optionsForIntent("motivated")).toEqual([
      "firm_hold",
      "soft_counter",
      "ask_for_pof",
    ]);
  });

  it("lukewarm → soft_nurture + ask_for_pof", () => {
    expect(optionsForIntent("lukewarm")).toEqual(["soft_nurture", "ask_for_pof"]);
  });

  it("rejection → decline_politely only", () => {
    expect(optionsForIntent("rejection")).toEqual(["decline_politely"]);
  });

  it("question → answer_question only", () => {
    expect(optionsForIntent("question")).toEqual(["answer_question"]);
  });

  it("alert-only intents return empty list", () => {
    expect(optionsForIntent("wire_fraud_red_flag")).toEqual([]);
    expect(optionsForIntent("off_topic")).toEqual([]);
    expect(optionsForIntent("spam")).toEqual([]);
  });
});

describe("coerceDraftOption", () => {
  it("passes through canonical options", () => {
    expect(coerceDraftOption("firm_hold")).toBe("firm_hold");
    expect(coerceDraftOption("soft_counter")).toBe("soft_counter");
    expect(coerceDraftOption("ask_for_pof")).toBe("ask_for_pof");
    expect(coerceDraftOption("decline_politely")).toBe("decline_politely");
  });

  it("normalizes case + dashes + spaces", () => {
    expect(coerceDraftOption("FIRM-HOLD")).toBe("firm_hold");
    expect(coerceDraftOption("ask for pof")).toBe("ask_for_pof");
  });

  it("defaults unknown to alert_only", () => {
    expect(coerceDraftOption("made_up")).toBe("alert_only");
    expect(coerceDraftOption(null)).toBe("alert_only");
    expect(coerceDraftOption(42)).toBe("alert_only");
  });
});

describe("coerceChannel", () => {
  it("passes through sms/email/none", () => {
    expect(coerceChannel("sms")).toBe("sms");
    expect(coerceChannel("email")).toBe("email");
    expect(coerceChannel("none")).toBe("none");
  });

  it("defaults to sms on unknown / non-string", () => {
    expect(coerceChannel("phone")).toBe("sms");
    expect(coerceChannel(null)).toBe("sms");
  });
});

describe("coerceDraft", () => {
  it("coerces a well-formed model draft", () => {
    const d = coerceDraft({
      option: "firm_hold",
      channel: "sms",
      body: "  $90K is the highest we can stretch.  ",
    });
    expect(d.option).toBe("firm_hold");
    expect(d.channel).toBe("sms");
    expect(d.body).toBe("$90K is the highest we can stretch.");
    expect(d.label).toBe("Firm hold");
    expect(d.subject).toBeUndefined();
  });

  it("truncates body at 2000 chars", () => {
    const long = "a".repeat(3000);
    const d = coerceDraft({ option: "soft_counter", channel: "sms", body: long });
    expect(d.body.length).toBe(2000);
  });

  it("alert_only forces channel=none and body=empty", () => {
    const d = coerceDraft({ option: "alert_only", channel: "sms", body: "anything" });
    expect(d.channel).toBe("none");
    expect(d.body).toBe("");
  });

  it("email channel preserves subject when present", () => {
    const d = coerceDraft({
      option: "answer_question",
      channel: "email",
      body: "Yes, we close in 14 days.",
      subject: "Re: timing",
    });
    expect(d.subject).toBe("Re: timing");
  });

  it("sms drops subject even if model included one", () => {
    const d = coerceDraft({
      option: "firm_hold",
      channel: "sms",
      body: "x",
      subject: "ignored",
    });
    expect(d.subject).toBeUndefined();
  });
});

describe("coerceDraftPackage", () => {
  it("filters drafts to those allowed by the intent's option list", () => {
    const c = mkClassification("rejection");
    const pkg = coerceDraftPackage(
      {
        drafts: [
          { option: "decline_politely", channel: "sms", body: "thanks for the update." },
          { option: "firm_hold", channel: "sms", body: "$90K." }, // not allowed for rejection
        ],
      },
      c,
      "claude-test",
      fixedNow,
    );
    expect(pkg.drafts).toHaveLength(1);
    expect(pkg.drafts[0].option).toBe("decline_politely");
  });

  it("dedupes by option (keeps first occurrence)", () => {
    const c = mkClassification("motivated");
    const pkg = coerceDraftPackage(
      {
        drafts: [
          { option: "firm_hold", channel: "sms", body: "first" },
          { option: "firm_hold", channel: "sms", body: "second" },
        ],
      },
      c,
      "claude-test",
      fixedNow,
    );
    expect(pkg.drafts).toHaveLength(1);
    expect(pkg.drafts[0].body).toBe("first");
  });

  it("alert-only intents return drafts: [] regardless of model output", () => {
    const c = mkClassification("wire_fraud_red_flag");
    const pkg = coerceDraftPackage(
      {
        drafts: [{ option: "firm_hold", channel: "sms", body: "$90K" }],
      },
      c,
      "claude-test",
      fixedNow,
    );
    expect(pkg.drafts).toEqual([]);
    expect(pkg.recommended_index).toBe(0);
  });

  it("accepts a top-level array (not just { drafts: [...] })", () => {
    const c = mkClassification("question");
    const pkg = coerceDraftPackage(
      [{ option: "answer_question", channel: "sms", body: "we close in 14d" }],
      c,
      "claude-test",
      fixedNow,
    );
    expect(pkg.drafts).toHaveLength(1);
  });

  it("clamps recommended_index into [0, drafts.length)", () => {
    const c = mkClassification("motivated");
    const pkg = coerceDraftPackage(
      {
        drafts: [
          { option: "firm_hold", channel: "sms", body: "a" },
          { option: "soft_counter", channel: "sms", body: "b" },
        ],
        recommended_index: 99,
      },
      c,
      "claude-test",
      fixedNow,
    );
    expect(pkg.recommended_index).toBe(0);
  });

  it("respects in-range recommended_index", () => {
    const c = mkClassification("motivated");
    const pkg = coerceDraftPackage(
      {
        drafts: [
          { option: "firm_hold", channel: "sms", body: "a" },
          { option: "soft_counter", channel: "sms", body: "b" },
        ],
        recommended_index: 1,
      },
      c,
      "claude-test",
      fixedNow,
    );
    expect(pkg.recommended_index).toBe(1);
  });

  it("echoes classification + model + generated_at", () => {
    const c = mkClassification("motivated", { confidence: 0.7 });
    const pkg = coerceDraftPackage({}, c, "claude-test", fixedNow);
    expect(pkg.classification).toBe(c);
    expect(pkg.model).toBe("claude-test");
    expect(pkg.generated_at).toBe("2026-05-18T20:00:00.000Z");
  });
});

describe("buildDrafterUserPrompt", () => {
  const baseInput: SentinelClassifierInput = {
    body: "we're firm at list",
    listing: { address: "X", list_price: 100000, state: "TX" },
    agent: { name: "Jane" },
  };

  it("includes the inbound body + listing context + classification verdict", () => {
    const c = mkClassification("rejection", { confidence: 0.9, reasoning: "firm-at-list" });
    const p = buildDrafterUserPrompt(baseInput, c);
    expect(p).toContain(`"""\nwe're firm at list\n"""`);
    expect(p).toContain("intent: rejection");
    expect(p).toContain("confidence: 0.90");
    expect(p).toContain("firm-at-list");
  });

  it("lists the option IDs Sentinel should generate (intent-driven)", () => {
    const c = mkClassification("motivated");
    const p = buildDrafterUserPrompt(baseInput, c);
    expect(p).toContain("firm_hold, soft_counter, ask_for_pof");
  });

  it("declares alert-only path explicitly when intent doesn't warrant drafts", () => {
    const c = mkClassification("wire_fraud_red_flag");
    const p = buildDrafterUserPrompt(baseInput, c);
    expect(p).toContain("(none — alert only)");
  });

  it("renders red_flags when present", () => {
    const c = mkClassification("wire_fraud_red_flag", {
      red_flags: ["phishing_link", "request_wire_transfer"],
    });
    const p = buildDrafterUserPrompt(baseInput, c);
    expect(p).toContain("red_flags: phishing_link, request_wire_transfer");
  });
});

describe("draftRepliesFor (alert-only short-circuit)", () => {
  const input: SentinelClassifierInput = {
    body: "send me your routing number",
    listing: { address: "X", list_price: 100000, state: "TX" },
    agent: { name: "Jane" },
  };

  it("skips LLM call for wire_fraud_red_flag", async () => {
    let called = false;
    const out = await draftRepliesFor(input, mkClassification("wire_fraud_red_flag"), {
      model: "claude-test",
      now: fixedNow,
      callAnthropic: async () => {
        called = true;
        return "[]";
      },
    });
    expect(called).toBe(false);
    expect(out.drafts).toEqual([]);
    expect(out.generated_at).toBe("2026-05-18T20:00:00.000Z");
  });

  it("skips LLM call for off_topic", async () => {
    let called = false;
    const out = await draftRepliesFor(input, mkClassification("off_topic"), {
      model: "claude-test",
      now: fixedNow,
      callAnthropic: async () => {
        called = true;
        return "[]";
      },
    });
    expect(called).toBe(false);
    expect(out.drafts).toEqual([]);
  });

  it("skips LLM call for spam", async () => {
    let called = false;
    await draftRepliesFor(input, mkClassification("spam"), {
      model: "claude-test",
      now: fixedNow,
      callAnthropic: async () => {
        called = true;
        return "[]";
      },
    });
    expect(called).toBe(false);
  });
});

describe("draftRepliesFor (injected fetcher, normal path)", () => {
  const input: SentinelClassifierInput = {
    body: "yes, send me your best offer",
    listing: { address: "1219 E Highland", list_price: 163000, state: "TX" },
    agent: { name: "Jane" },
  };

  it("returns drafts filtered to the intent's option list", async () => {
    const out = await draftRepliesFor(
      input,
      mkClassification("motivated"),
      {
        model: "claude-test",
        now: fixedNow,
        callAnthropic: async () =>
          JSON.stringify([
            { option: "firm_hold", channel: "sms", body: "$90K works." },
            { option: "soft_counter", channel: "sms", body: "Could go $95K." },
            { option: "ask_for_pof", channel: "sms", body: "POF source?" },
          ]),
      },
    );
    expect(out.drafts).toHaveLength(3);
    expect(out.drafts.map((d) => d.option)).toEqual([
      "firm_hold",
      "soft_counter",
      "ask_for_pof",
    ]);
    expect(out.drafts[0].label).toBe("Firm hold");
  });

  it("falls through to empty drafts on garbled model output", async () => {
    const out = await draftRepliesFor(input, mkClassification("motivated"), {
      model: "claude-test",
      now: fixedNow,
      callAnthropic: async () => "this is not json",
    });
    expect(out.drafts).toEqual([]);
  });

  it("propagates fetcher errors", async () => {
    await expect(
      draftRepliesFor(input, mkClassification("motivated"), {
        model: "claude-test",
        callAnthropic: async () => {
          throw new Error("anthropic_500");
        },
      }),
    ).rejects.toThrow("anthropic_500");
  });
});
