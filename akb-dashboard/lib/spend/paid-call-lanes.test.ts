// Pins the shared paid-API spend meter (2026-07-29).
//
// The invariant that matters: lanes yield in priority order, so the lane
// that earns revenue is the LAST to lose budget. Per-path budgets already
// failed twice — the frontier governor (2026-07-11) capped only the ZIP
// crawler while three ungoverned features shipped on top of it within nine
// days, taking measured usage from 2 calls/day to 231/day on a 1,000-call
// plan. If someone reorders these fractions, the money lane starves before
// the graveyard sweep does, and these tests fail.

import { describe, it, expect, afterEach } from "vitest";
import {
  checkLaneSpend,
  laneCeiling,
  paidCallsDailyCeiling,
  LANE_BUDGET_FRACTION,
  type SpendLane,
} from "@/lib/spend/paid-call-lanes";

const saved: { ceiling?: string } = {};
afterEach(() => {
  if (saved.ceiling === undefined) delete process.env.PAID_CALLS_DAILY_CEILING;
  else process.env.PAID_CALLS_DAILY_CEILING = saved.ceiling;
  saved.ceiling = undefined;
});
function setCeiling(v: string | undefined): void {
  if (saved.ceiling === undefined) saved.ceiling = process.env.PAID_CALLS_DAILY_CEILING;
  if (v === undefined) delete process.env.PAID_CALLS_DAILY_CEILING;
  else process.env.PAID_CALLS_DAILY_CEILING = v;
}

describe("paidCallsDailyCeiling", () => {
  it("defaults to 250 calls/24h", () => {
    setCeiling(undefined);
    expect(paidCallsDailyCeiling()).toBe(250);
  });

  it.each(["0", "-5", "junk", ""])("falls back to the default on invalid input %j", (raw) => {
    setCeiling(raw);
    expect(paidCallsDailyCeiling()).toBe(250);
  });

  it("honors a valid override so the ceiling can be tightened as fixes land", () => {
    setCeiling("120");
    expect(paidCallsDailyCeiling()).toBe(120);
  });
});

describe("lane priority", () => {
  // THE LOAD-BEARING INVARIANT.
  it("orders lanes so the live-deal lane yields last", () => {
    const order: SpendLane[] = ["sweep", "batch", "discovery", "live"];
    for (let i = 1; i < order.length; i++) {
      expect(LANE_BUDGET_FRACTION[order[i]]).toBeGreaterThan(
        LANE_BUDGET_FRACTION[order[i - 1]],
      );
    }
  });

  it("gives the live lane the full ceiling", () => {
    expect(LANE_BUDGET_FRACTION.live).toBe(1.0);
    expect(laneCeiling("live", 200)).toBe(200);
  });

  it("stops the sweep while the live lane still has headroom", () => {
    const ceiling = 200;
    const spent = 60; // past sweep's 50, under live's 200
    expect(checkLaneSpend("sweep", spent, ceiling).allowed).toBe(false);
    expect(checkLaneSpend("live", spent, ceiling).allowed).toBe(true);
  });

  it("stops batch before discovery, and discovery before live", () => {
    const ceiling = 200;
    const spent = 120; // past batch's 100, under discovery's 150
    expect(checkLaneSpend("batch", spent, ceiling).allowed).toBe(false);
    expect(checkLaneSpend("discovery", spent, ceiling).allowed).toBe(true);
    expect(checkLaneSpend("live", spent, ceiling).allowed).toBe(true);
  });
});

describe("checkLaneSpend", () => {
  it("allows a lane below its ceiling", () => {
    const v = checkLaneSpend("sweep", 10, 200);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("ok");
    expect(v.laneCeiling).toBe(50);
  });

  it("refuses exactly AT the lane ceiling, not one past it", () => {
    expect(checkLaneSpend("sweep", 50, 200).allowed).toBe(false);
    expect(checkLaneSpend("sweep", 49, 200).allowed).toBe(true);
  });

  it("FAILS OPEN when the meter is unreadable — an outage must not stall deals", () => {
    for (const lane of ["sweep", "batch", "discovery", "live"] as SpendLane[]) {
      const v = checkLaneSpend(lane, null, 200);
      expect(v.allowed).toBe(true);
      expect(v.reason).toBe("meter_unreadable_fail_open");
      expect(v.spent24h).toBeNull();
    }
  });

  it("refuses every lane once the full ceiling is exhausted", () => {
    for (const lane of ["sweep", "batch", "discovery", "live"] as SpendLane[]) {
      expect(checkLaneSpend(lane, 250, 250).allowed).toBe(false);
    }
  });

  it("reports the numbers needed to audit a refusal", () => {
    const v = checkLaneSpend("batch", 199, 200);
    expect(v).toMatchObject({
      allowed: false,
      spent24h: 199,
      laneCeiling: 100,
      ceiling: 200,
      lane: "batch",
      reason: "lane_ceiling_reached",
    });
  });
});
