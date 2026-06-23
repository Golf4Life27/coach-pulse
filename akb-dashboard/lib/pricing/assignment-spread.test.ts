import { describe, it, expect } from "vitest";
import { evaluateAssignmentSpread } from "./assignment-spread";
import { DEFAULT_WHOLESALE_FEE } from "../pre-contract-math";

describe("evaluateAssignmentSpread — the SELL-side dispo gate", () => {
  it("PASSES when the assignment clears contract + fee", () => {
    // contract $40k, fee $5k → floor $45k; assign $52k → spread $12k ≥ $5k.
    const r = evaluateAssignmentSpread({ assignmentPrice: 52_000, contractPrice: 40_000 });
    expect(r.status).toBe("pass");
    expect(r.assignmentFloor).toBe(45_000);
    expect(r.realizedSpread).toBe(12_000);
    expect(r.wholesaleFeeUsed).toBe(DEFAULT_WHOLESALE_FEE);
  });

  it("PASSES exactly at the floor (assignment == contract + fee)", () => {
    const r = evaluateAssignmentSpread({ assignmentPrice: 45_000, contractPrice: 40_000 });
    expect(r.status).toBe("pass");
    expect(r.realizedSpread).toBe(5_000);
  });

  it("BLOCKS one dollar below the floor — the 'too tight to dispo' guard", () => {
    const r = evaluateAssignmentSpread({ assignmentPrice: 44_999, contractPrice: 40_000 });
    expect(r.status).toBe("block");
    expect(r.assignmentFloor).toBe(45_000);
    expect(r.reason).toContain("too tight to dispo");
  });

  it("BLOCKS a thin spread that doesn't cover the fee (the historical failure)", () => {
    // assign $42k on a $40k contract → spread $2k < $5k fee → loss after fee.
    const r = evaluateAssignmentSpread({ assignmentPrice: 42_000, contractPrice: 40_000 });
    expect(r.status).toBe("block");
    expect(r.realizedSpread).toBe(2_000);
  });

  it("BLOCKS a negative spread (assignment below contract)", () => {
    const r = evaluateAssignmentSpread({ assignmentPrice: 38_000, contractPrice: 40_000 });
    expect(r.status).toBe("block");
    expect(r.realizedSpread).toBe(-2_000);
  });

  it("HOLDS (never blocks) when the contract price is unknown", () => {
    for (const cp of [null, undefined, 0, -1]) {
      const r = evaluateAssignmentSpread({ assignmentPrice: 52_000, contractPrice: cp as number });
      expect(r.status).toBe("hold");
      expect(r.assignmentFloor).toBeNull();
      expect(r.realizedSpread).toBeNull();
    }
  });

  it("HOLDS when the assignment price is unset, but surfaces the floor to clear", () => {
    const r = evaluateAssignmentSpread({ assignmentPrice: null, contractPrice: 40_000 });
    expect(r.status).toBe("hold");
    expect(r.assignmentFloor).toBe(45_000);
    expect(r.reason).toContain("45,000");
  });

  it("honors a custom (higher) wholesale fee — off-market/deal-type aware", () => {
    // fee $12k → floor $52k; assign $52k passes, $51,999 blocks.
    expect(evaluateAssignmentSpread({ assignmentPrice: 52_000, contractPrice: 40_000, wholesaleFee: 12_000 }).status).toBe("pass");
    expect(evaluateAssignmentSpread({ assignmentPrice: 51_999, contractPrice: 40_000, wholesaleFee: 12_000 }).status).toBe("block");
  });

  it("falls back to the default fee when the override is invalid", () => {
    const r = evaluateAssignmentSpread({ assignmentPrice: 52_000, contractPrice: 40_000, wholesaleFee: -3 });
    expect(r.wholesaleFeeUsed).toBe(DEFAULT_WHOLESALE_FEE);
    expect(r.status).toBe("pass");
  });
});
