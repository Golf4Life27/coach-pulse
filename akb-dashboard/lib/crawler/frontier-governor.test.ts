import { describe, it, expect } from "vitest";
import {
  computeDailyCrawlBudget,
  daysLeftInUtcMonth,
  governRunCap,
  crawlMeterKey,
  frontierDecisions,
  TARGET_CYCLE_DAYS,
  type FrontierZipRow,
} from "./frontier-governor";

const JUL_11 = new Date("2026-07-11T13:00:00Z");

describe("daysLeftInUtcMonth", () => {
  it("includes today", () => {
    expect(daysLeftInUtcMonth(JUL_11)).toBe(21); // Jul 11..31
    expect(daysLeftInUtcMonth(new Date("2026-07-31T23:00:00Z"))).toBe(1);
    expect(daysLeftInUtcMonth(new Date("2026-02-01T00:00:00Z"))).toBe(28);
  });
});

describe("computeDailyCrawlBudget", () => {
  it("spreads the remaining estimate over the days left, minus reserve", () => {
    const b = computeDailyCrawlBudget({
      monthlyPlan: 1000,
      estimatedRemaining: 1000,
      now: JUL_11,
    });
    // floor(1000/21)=47 − reserve 3 = 44
    expect(b.basis).toBe("estimated_remaining");
    expect(b.dailyBudget).toBe(44);
    expect(b.daysLeftInCycle).toBe(21);
  });

  it("falls back to plan pro-rata when the estimate is unavailable", () => {
    const b = computeDailyCrawlBudget({
      monthlyPlan: 1000,
      estimatedRemaining: null,
      now: JUL_11,
    });
    // floor(1000/31)=32 − 3 = 29 — can never overshoot the plan
    expect(b.basis).toBe("plan_prorata");
    expect(b.dailyBudget).toBe(29);
  });

  it("never goes negative and honors a custom reserve", () => {
    expect(
      computeDailyCrawlBudget({ monthlyPlan: 1000, estimatedRemaining: 10, now: JUL_11 }).dailyBudget,
    ).toBe(0); // floor(10/21)=0 − 3 → clamped 0
    expect(
      computeDailyCrawlBudget({ monthlyPlan: 1000, estimatedRemaining: 1000, now: JUL_11, reserve: 0 }).dailyBudget,
    ).toBe(47);
  });
});

describe("governRunCap", () => {
  it("clamps the run to the unspent daily allowance", () => {
    const v = governRunCap({ envZipCap: 10, dailyBudget: 29, usedToday: 25 });
    expect(v.zipCapThisRun).toBe(4);
    expect(v.allowanceLeftToday).toBe(4);
    expect(v.meterReadable).toBe(true);
  });

  it("passes the env cap through when budget headroom is wide", () => {
    const v = governRunCap({ envZipCap: 10, dailyBudget: 29, usedToday: 0 });
    expect(v.zipCapThisRun).toBe(10);
  });

  it("zeroes the run when today's budget is spent", () => {
    const v = governRunCap({ envZipCap: 10, dailyBudget: 29, usedToday: 29 });
    expect(v.zipCapThisRun).toBe(0);
  });

  it("falls back to the env cap alone when the meter is unreadable", () => {
    const v = governRunCap({ envZipCap: 10, dailyBudget: 29, usedToday: null });
    expect(v.zipCapThisRun).toBe(10);
    expect(v.meterReadable).toBe(false);
  });
});

describe("crawlMeterKey", () => {
  it("keys by UTC date", () => {
    expect(crawlMeterKey(JUL_11)).toBe("rentcast:intake:calls:2026-07-11");
  });
});

function row(overrides: Partial<FrontierZipRow>): FrontierZipRow {
  return {
    recordId: "recZIP0000000001",
    zip: "48205",
    marketTier: "active",
    wholesaleRestricted: false,
    lastIngestedAt: "2026-07-08T13:00:00Z",
    recordsIngested30d: 3,
    acceptRate30d: 0.1,
    ...overrides,
  };
}

describe("frontierDecisions", () => {
  it("promotes staged rows up to sustainable capacity", () => {
    const rows = [
      ...Array.from({ length: 80 }, (_, i) => row({ recordId: `recA${i}`, zip: String(48200 + i) })),
      row({ recordId: "recS1", zip: "44120", marketTier: "staged" }),
      row({ recordId: "recS2", zip: "44121", marketTier: "staged" }),
      row({ recordId: "recS3", zip: "44125", marketTier: "staged" }),
    ];
    const d = frontierDecisions({ rows, dailyBudget: 28, now: JUL_11 });
    expect(d.sustainableZips).toBe(28 * TARGET_CYCLE_DAYS); // 84
    expect(d.eligibleNow).toBe(80);
    expect(d.capacityLeft).toBe(4);
    expect(d.promote.map((r) => r.recordId)).toEqual(["recS1", "recS2", "recS3"]);
  });

  it("promotes nothing when the registry already fills capacity", () => {
    const rows = [
      ...Array.from({ length: 90 }, (_, i) => row({ recordId: `recA${i}`, zip: String(30000 + i) })),
      row({ recordId: "recS1", zip: "44120", marketTier: "staged" }),
    ];
    const d = frontierDecisions({ rows, dailyBudget: 28, now: JUL_11 });
    expect(d.capacityLeft).toBe(0);
    expect(d.promote).toHaveLength(0);
  });

  it("never promotes wholesale-restricted or malformed rows", () => {
    const rows = [
      row({ recordId: "recS1", zip: "27601", marketTier: "staged", wholesaleRestricted: true }),
      row({ recordId: "recS2", zip: "4412", marketTier: "staged" }),
    ];
    const d = frontierDecisions({ rows, dailyBudget: 28, now: JUL_11 });
    expect(d.promote).toHaveLength(0);
  });

  it("proposes retirement only for crawled-yet-zero-yield rows", () => {
    const rows = [
      row({ recordId: "recDead", zip: "77051", recordsIngested30d: 0, acceptRate30d: 0 }),
      row({ recordId: "recNeverCrawled", zip: "77052", lastIngestedAt: null, recordsIngested30d: 0, acceptRate30d: 0 }),
      row({ recordId: "recStaleStamp", zip: "77053", lastIngestedAt: "2026-05-01T00:00:00Z", recordsIngested30d: 0, acceptRate30d: 0 }),
      row({ recordId: "recProducing", zip: "77054", recordsIngested30d: 5, acceptRate30d: 0.2 }),
    ];
    const d = frontierDecisions({ rows, dailyBudget: 28, now: JUL_11 });
    expect(d.retireCandidates.map((c) => c.row.recordId)).toEqual(["recDead"]);
  });
});

// ── Cost-weighted capacity + paused exclusion (chew-and-move-on, 2026-07-22) ──

import { zipDailyCallCost, TARGET_CYCLE_DAYS as CYCLE } from "./frontier-governor";

describe("zipDailyCallCost", () => {
  it("producing / cooling ZIPs cost the target-cycle rate (1/3)", () => {
    expect(zipDailyCallCost(row({}))).toBeCloseTo(1 / 3);
    expect(zipDailyCallCost(row({ recordsIngested30d: 0, acceptRate30d: 0 }))).toBeCloseTo(1 / 3);
  });

  it("chewed ZIPs (sustained zero yield) cost the weekly rate (1/7)", () => {
    expect(
      zipDailyCallCost(row({ recordsIngested30d: 0, acceptRate30d: 0, zeroYieldStreak: 3 })),
    ).toBeCloseTo(1 / 7);
  });

  it("opener-HOLD ZIPs cost the biweekly trickle rate (1/14)", () => {
    expect(zipDailyCallCost(row({ openerHold: true }))).toBeCloseTo(1 / 14);
  });
});

describe("frontierDecisions — capacity unfreezes as metros are chewed", () => {
  it("a chewed registry frees promotion capacity the flat model denied", () => {
    // 90 eligible rows would freeze the old model (90 > 28×3 = 84).
    // Here 60 of them are chewed (weekly) → cost 60/7 + 30/3 ≈ 18.6/day,
    // leaving ~9.4 calls/day of headroom → 28 promotion seats.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => row({ recordId: `recP${i}`, zip: String(48200 + i) })),
      ...Array.from({ length: 60 }, (_, i) =>
        row({ recordId: `recC${i}`, zip: String(30000 + i), recordsIngested30d: 0, acceptRate30d: 0, zeroYieldStreak: 4 }),
      ),
      ...Array.from({ length: 40 }, (_, i) => row({ recordId: `recS${i}`, zip: String(44100 + i), marketTier: "staged" })),
    ];
    const d = frontierDecisions({ rows, dailyBudget: 28, now: JUL_11 });
    expect(d.eligibleNow).toBe(90);
    expect(d.currentDailyCost).toBeCloseTo(30 / 3 + 60 / 7, 1);
    expect(d.capacityLeft).toBe(Math.floor((28 - (30 / 3 + 60 / 7)) * CYCLE));
    expect(d.promote.length).toBe(d.capacityLeft);
  });

  it("paused-market rows neither crawl nor hold capacity seats", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) =>
        row({ recordId: `recM${i}`, zip: String(38109 + i), pausedMarket: true }),
      ),
      row({ recordId: "recS1", zip: "44120", marketTier: "staged" }),
    ];
    const d = frontierDecisions({ rows, dailyBudget: 2, now: JUL_11 });
    expect(d.eligibleNow).toBe(0);
    expect(d.pausedExcluded).toBe(6);
    expect(d.currentDailyCost).toBe(0);
    expect(d.promote.map((r) => r.zip)).toEqual(["44120"]);
  });

  it("opener-HOLD TX cluster barely dents the budget", () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      row({ recordId: `recTX${i}`, zip: String(78200 + i), openerHold: true }),
    );
    const d = frontierDecisions({ rows, dailyBudget: 28, now: JUL_11 });
    expect(d.currentDailyCost).toBeCloseTo(21 / 14, 1); // 1.5 calls/day, was 7/day flat
  });
});
