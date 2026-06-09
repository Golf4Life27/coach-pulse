import { describe, it, expect } from "vitest";
import { evaluateBreaker, FIRECRAWL_HOURLY_CREDIT_CAP } from "./firecrawl-circuit-breaker";

describe("evaluateBreaker", () => {
  it("does not trip under the cap", () => {
    const r = evaluateBreaker(300, 800);
    expect(r.tripped).toBe(false);
    expect(r.headroom).toBe(500);
  });

  it("trips at the cap", () => {
    expect(evaluateBreaker(800, 800).tripped).toBe(true);
  });

  it("trips over the cap (the runaway) and clamps headroom to 0", () => {
    const r = evaluateBreaker(5_000, 800);
    expect(r.tripped).toBe(true);
    expect(r.headroom).toBe(0);
  });

  it("treats a negative / NaN spend as 0 (defensive)", () => {
    expect(evaluateBreaker(-1, 800).spentRecent).toBe(0);
    expect(evaluateBreaker(Number.NaN, 800).tripped).toBe(false);
  });

  it("defaults to the configured hourly cap", () => {
    expect(evaluateBreaker(FIRECRAWL_HOURLY_CREDIT_CAP).tripped).toBe(true);
    expect(evaluateBreaker(FIRECRAWL_HOURLY_CREDIT_CAP - 1).tripped).toBe(false);
  });

  it("default cap is a sane 800 (env-tunable)", () => {
    // The drained run did ~980/hr — 800 trips before a full-registry cycle.
    expect(FIRECRAWL_HOURLY_CREDIT_CAP).toBe(800);
  });
});
