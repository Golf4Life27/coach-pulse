// Phase 13 / N.4 — Sentinel motivation-gate tests.
//
// Locks the pure decision boundary that gates the Seller_Motivation_
// Score auto-write on /api/sentinel/classify/[recordId]?apply_motivation=1.
// The route wraps this helper around the actual updateListingRecord
// call, so every "apply" or "skip" path through the destructive
// boundary is anchored here.

import { describe, it, expect } from "vitest";
import { decideMotivationApply } from "./motivation-gate";
import type { SentinelClassification, SentinelIntent } from "./types";

function mkClassification(
  intent: SentinelIntent,
  motivation_score_hint: number | null = 3,
): Pick<SentinelClassification, "intent" | "motivation_score_hint"> {
  return { intent, motivation_score_hint };
}

describe("decideMotivationApply", () => {
  it("apply when intent=motivated + hint set + apply flag + no existing score", () => {
    const r = decideMotivationApply({
      apply: true,
      classification: mkClassification("motivated", 4),
      existingScore: null,
    });
    expect(r).toEqual({ decision: "apply", score: 4 });
  });

  it("apply when intent=lukewarm (also eligible)", () => {
    const r = decideMotivationApply({
      apply: true,
      classification: mkClassification("lukewarm", 2),
      existingScore: null,
    });
    expect(r).toEqual({ decision: "apply", score: 2 });
  });

  it("skip not_requested when apply flag false (even if all other gates pass)", () => {
    const r = decideMotivationApply({
      apply: false,
      classification: mkClassification("motivated", 4),
      existingScore: null,
    });
    expect(r).toMatchObject({ decision: "skip", reason: "not_requested" });
  });

  it("skip intent_not_motivated_or_lukewarm for rejection / question / wire-fraud / off-topic / spam", () => {
    for (const intent of [
      "rejection",
      "question",
      "wire_fraud_red_flag",
      "off_topic",
      "spam",
    ] as const) {
      const r = decideMotivationApply({
        apply: true,
        classification: mkClassification(intent, 4),
        existingScore: null,
      });
      expect(r).toMatchObject({
        decision: "skip",
        reason: "intent_not_motivated_or_lukewarm",
      });
    }
  });

  it("skip no_hint when motivation_score_hint is null", () => {
    const r = decideMotivationApply({
      apply: true,
      classification: mkClassification("motivated", null),
      existingScore: null,
    });
    expect(r).toMatchObject({ decision: "skip", reason: "no_hint", hint: null });
  });

  it("skip existing_score_set — never stomp operator-set value", () => {
    const r = decideMotivationApply({
      apply: true,
      classification: mkClassification("motivated", 4),
      existingScore: 2, // operator already scored
    });
    expect(r).toMatchObject({
      decision: "skip",
      reason: "existing_score_set",
      existing_score: 2,
      hint: 4,
    });
  });

  it("never-stomp also blocks when existing equals hint (no redundant writes)", () => {
    const r = decideMotivationApply({
      apply: true,
      classification: mkClassification("motivated", 3),
      existingScore: 3,
    });
    expect(r).toMatchObject({ decision: "skip", reason: "existing_score_set" });
  });

  it("never-stomp blocks even for very low existing values (1)", () => {
    const r = decideMotivationApply({
      apply: true,
      classification: mkClassification("motivated", 5),
      existingScore: 1,
    });
    expect(r).toMatchObject({ decision: "skip", reason: "existing_score_set" });
  });

  it("returns hint on skip rows for audit traceability", () => {
    const r = decideMotivationApply({
      apply: true,
      classification: mkClassification("rejection", 3),
      existingScore: null,
    });
    expect(r).toMatchObject({
      decision: "skip",
      reason: "intent_not_motivated_or_lukewarm",
      hint: 3,
      existing_score: null,
    });
  });

  it("apply scores at the boundary values 1 and 5", () => {
    expect(
      decideMotivationApply({
        apply: true,
        classification: mkClassification("motivated", 1),
        existingScore: null,
      }),
    ).toEqual({ decision: "apply", score: 1 });
    expect(
      decideMotivationApply({
        apply: true,
        classification: mkClassification("lukewarm", 5),
        existingScore: null,
      }),
    ).toEqual({ decision: "apply", score: 5 });
  });
});

describe("decideMotivationApply — gate-ordering invariants", () => {
  // The gate's reason ordering matters for audit clarity. These tests
  // pin down which reason wins when multiple gates would fail
  // simultaneously, so downstream Pulse can rely on the reason
  // taxonomy being stable.

  it("not_requested wins over intent gate (apply=false short-circuits)", () => {
    const r = decideMotivationApply({
      apply: false,
      classification: mkClassification("rejection", 3),
      existingScore: null,
    });
    expect(r).toMatchObject({ decision: "skip", reason: "not_requested" });
  });

  it("intent gate wins over no_hint (intent checked first)", () => {
    const r = decideMotivationApply({
      apply: true,
      classification: mkClassification("rejection", null),
      existingScore: null,
    });
    expect(r).toMatchObject({
      decision: "skip",
      reason: "intent_not_motivated_or_lukewarm",
    });
  });

  it("no_hint wins over existing_score_set (hint checked first)", () => {
    const r = decideMotivationApply({
      apply: true,
      classification: mkClassification("motivated", null),
      existingScore: 3,
    });
    expect(r).toMatchObject({ decision: "skip", reason: "no_hint" });
  });
});
