import { describe, it, expect } from "vitest";
import {
  countLostPhoneRisk,
  dealVelocity,
  operatorHours,
  buildCompletion,
  buildMeterSnapshot,
  type ClosedDeal,
} from "./compute";
import { PIPELINE_STAGES } from "./stages";

describe("countLostPhoneRisk", () => {
  it("counts the current registry honestly (4 HIGH stall stages)", () => {
    const r = countLostPhoneRisk();
    // The four back-half walls: underwrite, negotiate, contract, dispo.
    expect(r.high).toBe(4);
    expect(r.stallingStages).toEqual(
      expect.arrayContaining(["underwrite", "negotiate", "contract", "dispo"]),
    );
  });

  it("stallCount equals the number of stallsWithoutOperator stages", () => {
    const r = countLostPhoneRisk();
    const expected = PIPELINE_STAGES.filter((s) => s.stallsWithoutOperator).length;
    expect(r.stallCount).toBe(expected);
  });

  it("is pure over an injected registry", () => {
    const r = countLostPhoneRisk([
      { ...PIPELINE_STAGES[0], lostPhoneRisk: "HIGH", stallsWithoutOperator: true },
      { ...PIPELINE_STAGES[1], lostPhoneRisk: "LOW", stallsWithoutOperator: false },
    ]);
    expect(r.high).toBe(1);
    expect(r.low).toBe(1);
    expect(r.stallCount).toBe(1);
  });
});

describe("dealVelocity", () => {
  const NOW = new Date("2026-06-08T00:00:00Z");

  it("returns $0/mo on an empty deal set (current reality)", () => {
    const r = dealVelocity([], NOW);
    expect(r.monthlyNetUsd).toBe(0);
    expect(r.closedInWindow).toBe(0);
    expect(r.pctOfTarget).toBe(0);
  });

  it("sums fees inside the 90-day window and annualizes to monthly", () => {
    const deals: ClosedDeal[] = [
      { closedAt: "2026-05-20T00:00:00Z", assignmentFee: 12000 },
      { closedAt: "2026-04-15T00:00:00Z", assignmentFee: 9000 },
    ];
    const r = dealVelocity(deals, NOW, 90);
    expect(r.closedInWindow).toBe(2);
    expect(r.totalFeeInWindow).toBe(21000);
    expect(r.monthlyNetUsd).toBe(7000); // 21000 / 3 months
  });

  it("excludes deals outside the window", () => {
    const deals: ClosedDeal[] = [
      { closedAt: "2026-01-01T00:00:00Z", assignmentFee: 50000 }, // >90d ago
      { closedAt: "2026-06-01T00:00:00Z", assignmentFee: 6000 },
    ];
    const r = dealVelocity(deals, NOW, 90);
    expect(r.closedInWindow).toBe(1);
    expect(r.totalFeeInWindow).toBe(6000);
  });

  it("treats null/undated/zero fees as zero contribution", () => {
    const deals: ClosedDeal[] = [
      { closedAt: null, assignmentFee: 99999 },
      { closedAt: "2026-05-01T00:00:00Z", assignmentFee: null },
      { closedAt: "2026-05-02T00:00:00Z", assignmentFee: 0 },
    ];
    const r = dealVelocity(deals, NOW, 90);
    expect(r.closedInWindow).toBe(2); // the two dated ones
    expect(r.totalFeeInWindow).toBe(0);
  });

  it("measures against the $40K/mo Crawler-2.0 target", () => {
    const deals: ClosedDeal[] = [{ closedAt: "2026-06-01T00:00:00Z", assignmentFee: 60000 }];
    const r = dealVelocity(deals, NOW, 90);
    expect(r.targetMonthlyNetUsd).toBe(40000);
    expect(r.pctOfTarget).toBe(0.5); // 20000/mo / 40000
  });
});

describe("operatorHours", () => {
  it("passes through the estimate + computes over-target multiple", () => {
    const r = operatorHours();
    expect(r.targetHours).toBe(15);
    expect(r.measured).toBe(false);
    // midpoint (33+58)/2 = 45.5 / 15 ≈ 3.03
    expect(r.overTargetMultiple).toBeCloseTo(3.03, 1);
  });
});

describe("buildCompletion", () => {
  it("pipeline mean reflects 'front half works, back half unbuilt'", () => {
    const r = buildCompletion();
    expect(r.pipelinePct).toBeGreaterThan(40);
    expect(r.pipelinePct).toBeLessThan(70);
    expect(r.overallPct).toBeGreaterThanOrEqual(r.pipelinePct); // infra lifts it
    expect(r.perStage).toHaveLength(PIPELINE_STAGES.length);
  });
});

describe("buildMeterSnapshot", () => {
  it("assembles all three numbers + a headline", () => {
    const snap = buildMeterSnapshot({ deals: [], now: new Date("2026-06-08T00:00:00Z") });
    expect(snap.lostPhone.high).toBe(4);
    expect(snap.velocity.monthlyNetUsd).toBe(0);
    expect(snap.operatorHours.targetHours).toBe(15);
    expect(snap.headline).toContain("stall without operator");
    expect(snap.headline).toContain("/mo");
    expect(snap.headline).toContain("build");
  });
});
