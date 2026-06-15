import { describe, it, expect } from "vitest";
import { evaluateBreaker, shouldHaltVerify, FIRECRAWL_HOURLY_CREDIT_CAP } from "./firecrawl-circuit-breaker";

describe("shouldHaltVerify — balance/breaker gate", () => {
  it("does not halt when healthy (breaker ok, positive balance)", () => {
    const v = shouldHaltVerify({ breakerTripped: false, balanceRemaining: 5_000 });
    expect(v.halt).toBe(false);
    expect(v.reason).toBeNull();
  });

  it("halts on a drained wallet (balance ≤ 0) — the loop-burn root cause", () => {
    expect(shouldHaltVerify({ breakerTripped: false, balanceRemaining: -821 })).toEqual({
      halt: true, reason: "balance_nonpositive", balanceUnhealthy: true,
    });
    expect(shouldHaltVerify({ breakerTripped: false, balanceRemaining: 0 }).halt).toBe(true);
  });

  it("halts on a tripped spend breaker even with positive balance", () => {
    const v = shouldHaltVerify({ breakerTripped: true, balanceRemaining: 5_000 });
    expect(v.halt).toBe(true);
    expect(v.reason).toBe("spend_cap");
  });

  it("does NOT halt on an unknown (null) balance — never block on an unknown; breaker stays the backstop", () => {
    const v = shouldHaltVerify({ breakerTripped: false, balanceRemaining: null });
    expect(v.halt).toBe(false);
    expect(v.balanceUnhealthy).toBe(false);
  });

  it("balance reason takes precedence when both fire (root cause to fix)", () => {
    expect(shouldHaltVerify({ breakerTripped: true, balanceRemaining: -1 }).reason).toBe("balance_nonpositive");
  });
});

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
