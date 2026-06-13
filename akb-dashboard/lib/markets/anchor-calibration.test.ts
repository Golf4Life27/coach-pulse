import { describe, it, expect } from "vitest";
import {
  decideAnchorMove,
  applyDecision,
  isBaselineEstablished,
  SAMPLE_GATE,
  BASELINE_DAYS,
  BASELINE_SENDS,
  ABOVE_BASELINE_PCT,
  NEAR_ZERO_VS_BASELINE_PCT,
  BREAKER_CYCLES,
} from "./anchor-calibration";
import { freshAnchorState, ANCHOR_AUTOPILOT_CEILING, ANCHOR_FLOOR } from "./anchor";

const NOW = new Date("2026-06-13T00:00:00Z");
const PLUS_DAYS = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe("baseline gate — no movement before normal exists", () => {
  it("fresh market on its first cycle → hold (below_baseline_gate)", () => {
    const s = freshAnchorState("detroit_mi", NOW);
    const d = decideAnchorMove(s, { sends: 60, replies: 1, engagedReplies: 0 }, 60, PLUS_DAYS(7));
    expect(d.reason).toBe("below_baseline_gate");
    expect(d.newAnchorPct).toBe(0.90);
    expect(d.appliedStep).toBe(0);
  });
  it("14 days elapsed → baseline established this cycle, no anchor move yet", () => {
    const s = freshAnchorState("detroit_mi", NOW);
    const d = decideAnchorMove(s, { sends: 70, replies: 3, engagedReplies: 1 }, 70, PLUS_DAYS(BASELINE_DAYS));
    expect(d.reason).toBe("baseline_established");
    expect(d.newAnchorPct).toBe(0.90);
    // The CYCLE's reply rate is recorded as the baseline for future cycles.
    const next = applyDecision(s, d, PLUS_DAYS(BASELINE_DAYS));
    expect(next.baselineReplyRate).toBeCloseTo(3 / 70, 6);
  });
  it("200 sends in less than 14 days → baseline established by send-count gate", () => {
    const s = freshAnchorState("detroit_mi", NOW);
    expect(isBaselineEstablished(s, BASELINE_SENDS, PLUS_DAYS(5))).toBe(true);
  });
});

describe("sample gate — won't move on thin evidence", () => {
  it("<50 sends since last change → hold even when above baseline", () => {
    const s = { ...freshAnchorState("detroit_mi", NOW), baselineReplyRate: 0.05, sendsSinceLastChange: SAMPLE_GATE - 1 };
    const d = decideAnchorMove(s, { sends: 49, replies: 5, engagedReplies: 2 }, 1000, PLUS_DAYS(21));
    expect(d.reason).toBe("below_sample_gate");
    expect(d.appliedStep).toBe(0);
  });
});

describe("step rules — within / above / near-zero", () => {
  const base = (replyRate: number) => ({
    ...freshAnchorState("detroit_mi", NOW),
    baselineReplyRate: replyRate,
    sendsSinceLastChange: SAMPLE_GATE + 10,
  });
  it("within normal band → small downward bias (−1 point)", () => {
    const s = base(0.05);
    const d = decideAnchorMove(s, { sends: 60, replies: 3, engagedReplies: 1 }, 0, PLUS_DAYS(21));
    expect(d.reason).toBe("within_band");
    expect(d.appliedStep).toBeCloseTo(-0.01, 6);
  });
  it("notably above baseline (≥20% over) → drop 5 points", () => {
    const s = base(0.05);
    const reply = 0.05 * ABOVE_BASELINE_PCT * 1.1;
    const d = decideAnchorMove(s, { sends: 100, replies: Math.round(100 * reply), engagedReplies: 2 }, 0, PLUS_DAYS(21));
    expect(d.reason).toBe("above_baseline");
    expect(d.appliedStep).toBeCloseTo(-0.05, 6);
  });
  it("near zero (≤50% of baseline) → raise 5 points", () => {
    const s = base(0.05);
    const reply = 0.05 * NEAR_ZERO_VS_BASELINE_PCT * 0.5;
    const d = decideAnchorMove(s, { sends: 100, replies: Math.round(100 * reply), engagedReplies: 0 }, 0, PLUS_DAYS(21));
    expect(d.reason).toBe("near_zero_below_baseline");
    expect(d.appliedStep).toBeCloseTo(0.05, 6);
  });
});

describe("autopilot bounds — ceiling 1.00, floor 0.75", () => {
  it("never crosses 1.00 on autopilot — raise that would breach clamps", () => {
    const s = { ...freshAnchorState("detroit_mi", NOW), anchorPct: 0.98, baselineReplyRate: 0.05, sendsSinceLastChange: SAMPLE_GATE + 10 };
    const d = decideAnchorMove(s, { sends: 100, replies: 0, engagedReplies: 0 }, 0, PLUS_DAYS(21));
    expect(d.newAnchorPct).toBe(ANCHOR_AUTOPILOT_CEILING);
  });
  it("never crosses 0.75 floor on autopilot", () => {
    const s = { ...freshAnchorState("detroit_mi", NOW), anchorPct: 0.77, baselineReplyRate: 0.05, sendsSinceLastChange: SAMPLE_GATE + 10 };
    const d = decideAnchorMove(s, { sends: 100, replies: 20, engagedReplies: 5 }, 0, PLUS_DAYS(21));
    expect(d.newAnchorPct).toBe(ANCHOR_FLOOR);
  });
});

describe("circuit breaker — pinned at 1.00 with near-zero replies, 2 cycles", () => {
  it("first ceiling-pin cycle → no breaker yet", () => {
    const s = { ...freshAnchorState("detroit_mi", NOW), anchorPct: ANCHOR_AUTOPILOT_CEILING, baselineReplyRate: 0.05, sendsSinceLastChange: SAMPLE_GATE + 10, pinAtCeilingCycles: 0 };
    const d = decideAnchorMove(s, { sends: 100, replies: 0, engagedReplies: 0 }, 0, PLUS_DAYS(28));
    expect(d.breakerTrippedThisCycle).toBe(false);
    const next = applyDecision(s, d, PLUS_DAYS(28));
    expect(next.pinAtCeilingCycles).toBe(1);
  });
  it("second consecutive ceiling-pin cycle → breaker trips, market freezes", () => {
    const s = { ...freshAnchorState("detroit_mi", NOW), anchorPct: ANCHOR_AUTOPILOT_CEILING, baselineReplyRate: 0.05, sendsSinceLastChange: SAMPLE_GATE + 10, pinAtCeilingCycles: BREAKER_CYCLES - 1 };
    const d = decideAnchorMove(s, { sends: 100, replies: 0, engagedReplies: 0 }, 0, PLUS_DAYS(35));
    expect(d.breakerTrippedThisCycle).toBe(true);
    const next = applyDecision(s, d, PLUS_DAYS(35));
    expect(next.brokenAt).not.toBeNull();
  });
  it("broken market stays frozen until operator intervention", () => {
    const s = { ...freshAnchorState("detroit_mi", NOW), brokenAt: NOW.toISOString(), anchorPct: ANCHOR_AUTOPILOT_CEILING, baselineReplyRate: 0.05, sendsSinceLastChange: SAMPLE_GATE + 100 };
    const d = decideAnchorMove(s, { sends: 100, replies: 30, engagedReplies: 10 }, 0, PLUS_DAYS(50));
    expect(d.reason).toBe("broken_market");
    expect(d.appliedStep).toBe(0);
  });
});

describe("applyDecision bookkeeping", () => {
  it("sendsSinceLastChange resets to 0 only when the anchor actually moved", () => {
    const s = { ...freshAnchorState("detroit_mi", NOW), baselineReplyRate: 0.05, sendsSinceLastChange: 75, anchorPct: 0.85 };
    // Within band → small drop
    const dropDecision = decideAnchorMove(s, { sends: 60, replies: 3, engagedReplies: 1 }, 0, PLUS_DAYS(21));
    const next = applyDecision(s, dropDecision, PLUS_DAYS(21));
    expect(next.anchorPct).toBeCloseTo(0.84, 6);
    expect(next.sendsSinceLastChange).toBe(0);
    expect(next.lastAnchorChangeAt).not.toBeNull();
  });
});
