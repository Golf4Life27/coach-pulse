// INV-023 — evaluator-owned math gate (ruling 4: computed, never hand-flipped).
import { describe, it, expect } from "vitest";
import { computeMathGate } from "@/app/api/orchestrator/pre-emd-evaluate/route";

describe("computeMathGate", () => {
  it("green when Underwritten_MAO >= contract_price", () => {
    expect(computeMathGate(50_000, 48_000)).toBe("green");
    expect(computeMathGate(50_000, 50_000)).toBe("green"); // equality passes
  });
  it("red when contract_price > Underwritten_MAO — decisively against, block", () => {
    expect(computeMathGate(50_000, 52_000)).toBe("red");
  });
  it("not_yet_evaluated when either input is missing/non-positive — never guessed", () => {
    expect(computeMathGate(null, 50_000)).toBe("not_yet_evaluated");
    expect(computeMathGate(50_000, null)).toBe("not_yet_evaluated");
    expect(computeMathGate(0, 50_000)).toBe("not_yet_evaluated");
    expect(computeMathGate(50_000, 0)).toBe("not_yet_evaluated");
    expect(computeMathGate(null, null)).toBe("not_yet_evaluated");
  });
});
