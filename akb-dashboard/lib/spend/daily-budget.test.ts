import { describe, it, expect } from "vitest";
import { estimateDailySpendUsd, evaluateSeedBudget, DEFAULT_DAILY_INTAKE_BUDGET_USD } from "./daily-budget";

describe("estimateDailySpendUsd", () => {
  it("dollar-ises the count-based meter via the per-call cost table", () => {
    const usd = estimateDailySpendUsd({ rentcast: 100, attom: 10, total: 110 }, { rentcast: 0.20, attom: 0.50 });
    expect(usd).toBe(25); // 100×0.20 + 10×0.50
  });
});

describe("evaluateSeedBudget — clamps NEW seeds only", () => {
  it("allows a seed when current spend + one seed stays at/under the ceiling", () => {
    const v = evaluateSeedBudget({ spentUsd: 24.5, budgetUsd: 25, seedCostUsd: 0.20 });
    expect(v.canSeed).toBe(true);
  });

  it("PAUSES new seeds once the ceiling would be crossed by the very call", () => {
    const v = evaluateSeedBudget({ spentUsd: 24.9, budgetUsd: 25, seedCostUsd: 0.20 });
    expect(v.canSeed).toBe(false);
    expect(v.reason).toContain("PAUSED");
  });

  it("reports seeds of headroom remaining", () => {
    const v = evaluateSeedBudget({ spentUsd: 20, budgetUsd: 25, seedCostUsd: 1 });
    expect(v.seedsRemaining).toBe(5);
    expect(v.remainingUsd).toBe(5);
  });

  it("zero seed cost never authorizes (defensive)", () => {
    expect(evaluateSeedBudget({ spentUsd: 0, budgetUsd: 25, seedCostUsd: 0 }).canSeed).toBe(false);
  });

  it("default ceiling is the conservative $25", () => {
    expect(DEFAULT_DAILY_INTAKE_BUDGET_USD).toBe(25);
  });
});
