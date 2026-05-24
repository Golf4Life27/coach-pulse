// INV-022 Sprint 2 — rentcastBudgetAllows pure guard tests.

import { describe, it, expect } from "vitest";
import {
  rentcastBudgetAllows,
  RENTCAST_CREDITS_PER_HYDRATION,
} from "./rentcast-hydrate";

describe("rentcastBudgetAllows", () => {
  it("allows when remaining covers the request", () => {
    const d = rentcastBudgetAllows(100);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("ok");
    expect(d.requested).toBe(RENTCAST_CREDITS_PER_HYDRATION);
  });

  it("allows at the exact boundary", () => {
    expect(rentcastBudgetAllows(RENTCAST_CREDITS_PER_HYDRATION).allowed).toBe(true);
  });

  it("denies when remaining is one short", () => {
    const d = rentcastBudgetAllows(RENTCAST_CREDITS_PER_HYDRATION - 1);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("insufficient_budget");
  });

  it("denies at zero", () => {
    expect(rentcastBudgetAllows(0).allowed).toBe(false);
  });

  it("denies on negative (over budget)", () => {
    expect(rentcastBudgetAllows(-50).allowed).toBe(false);
  });

  it("denies on non-finite budget, including Infinity (defensive)", () => {
    expect(rentcastBudgetAllows(Number.NaN).allowed).toBe(false);
    expect(rentcastBudgetAllows(Number.POSITIVE_INFINITY).allowed).toBe(false);
  });

  it("respects a custom requested-credit count", () => {
    expect(rentcastBudgetAllows(3, 4).allowed).toBe(false);
    expect(rentcastBudgetAllows(4, 4).allowed).toBe(true);
  });
});
