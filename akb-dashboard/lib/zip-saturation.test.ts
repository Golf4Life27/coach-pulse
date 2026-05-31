import { describe, it, expect } from "vitest";
import {
  evaluateSaturation,
  DEFAULT_SATURATION_THRESHOLD,
  DEFAULT_STREAK_DAYS,
} from "./zip-saturation";

const base = {
  threshold: 0.05,
  previousStreak: 0,
  streakThreshold: DEFAULT_STREAK_DAYS,
  tier: "active" as const,
};

describe("evaluateSaturation", () => {
  it("extends the streak on a below-threshold day", () => {
    const ev = evaluateSaturation({ ...base, acceptRate: 0.02, considered: 100, previousStreak: 3 });
    expect(ev.evaluable).toBe(true);
    expect(ev.belowThreshold).toBe(true);
    expect(ev.newStreak).toBe(4);
    expect(ev.shouldSaturate).toBe(false);
  });

  it("resets the streak on a good day", () => {
    const ev = evaluateSaturation({ ...base, acceptRate: 0.2, considered: 100, previousStreak: 9 });
    expect(ev.belowThreshold).toBe(false);
    expect(ev.newStreak).toBe(0);
  });

  it("carries the streak unchanged on a no-sample (indeterminate) day", () => {
    const ev = evaluateSaturation({ ...base, acceptRate: null, considered: 0, previousStreak: 7 });
    expect(ev.evaluable).toBe(false);
    expect(ev.newStreak).toBe(7);
    expect(ev.shouldSaturate).toBe(false);
  });

  it("flips an active ZIP exactly at the streak threshold", () => {
    const ev = evaluateSaturation({
      ...base,
      acceptRate: 0.0,
      considered: 50,
      previousStreak: DEFAULT_STREAK_DAYS - 1,
    });
    expect(ev.newStreak).toBe(DEFAULT_STREAK_DAYS);
    expect(ev.shouldSaturate).toBe(true);
  });

  it("does NOT flip a launch ZIP even past the threshold", () => {
    const ev = evaluateSaturation({
      ...base,
      tier: "launch",
      acceptRate: 0.0,
      considered: 50,
      previousStreak: DEFAULT_STREAK_DAYS + 5,
    });
    expect(ev.belowThreshold).toBe(true);
    expect(ev.newStreak).toBe(DEFAULT_STREAK_DAYS + 6);
    expect(ev.shouldSaturate).toBe(false);
  });

  it("falls back to the default threshold when null or non-positive", () => {
    const justUnder = DEFAULT_SATURATION_THRESHOLD - 0.001;
    const ev = evaluateSaturation({
      ...base,
      threshold: null,
      acceptRate: justUnder,
      considered: 100,
    });
    expect(ev.thresholdUsed).toBe(DEFAULT_SATURATION_THRESHOLD);
    expect(ev.belowThreshold).toBe(true);
  });

  it("treats accept rate exactly at threshold as NOT below", () => {
    const ev = evaluateSaturation({ ...base, acceptRate: 0.05, considered: 100, previousStreak: 2 });
    expect(ev.belowThreshold).toBe(false);
    expect(ev.newStreak).toBe(0);
  });
});
