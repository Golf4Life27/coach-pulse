import { describe, it, expect } from "vitest";
import { northStarPace } from "./north-star-pace";

// 2026-07-11T16:00Z ≈ 11:00 Chicago (CDT) — day 11 of a 31-day month.
const MID_JULY = new Date("2026-07-11T16:00:00Z");

describe("northStarPace", () => {
  it("computes expected-to-date per target from the elapsed month fraction", () => {
    const v = northStarPace(10, MID_JULY);
    // fraction ≈ (10 + 11/24) / 31 ≈ 0.337
    expect(v.monthFraction).toBeGreaterThan(0.3);
    expect(v.monthFraction).toBeLessThan(0.4);
    const t10 = v.targets.find((t) => t.target === 10)!;
    const t50 = v.targets.find((t) => t.target === 50)!;
    expect(t10.onPace).toBe(true); // 10 counted ≥ ~3.4 expected
    expect(t50.expectedToDate).toBeGreaterThan(15);
    expect(t50.onPace).toBe(false);
  });

  it("headline names the highest target on pace; projection is straight-line", () => {
    const v = northStarPace(10, MID_JULY);
    expect(v.headline).toBe("on pace for 20/mo"); // 10 ≥ 20×0.337≈6.7, < 50×0.337≈16.9
    expect(v.projected).toBeGreaterThan(25);
    expect(v.tone).toBe("good");
  });

  it("zero counted at month start reads 'too soon', never celebrates zero, never divides by zero", () => {
    const early = northStarPace(0, new Date("2026-07-01T06:00:00Z"));
    expect(early.headline).toBe("month just started");
    expect(Number.isFinite(early.projected)).toBe(true);
    // Zero counted mid-month IS behind.
    const mid = northStarPace(0, MID_JULY);
    expect(mid.headline).toBe("below 10/mo pace");
    expect(mid.tone).toBe("behind");
  });

  it("on pace for only the 10 ladder rung reads warning", () => {
    const v = northStarPace(4, MID_JULY); // ≥3.4 (10/mo) but <6.7 (20/mo)
    expect(v.headline).toBe("on pace for 10/mo");
    expect(v.tone).toBe("warning");
  });
});
