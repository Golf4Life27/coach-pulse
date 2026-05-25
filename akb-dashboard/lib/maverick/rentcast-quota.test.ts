// Ship 2 — rentcastQuotaAllows gate tests.

import { describe, it, expect } from "vitest";
import { rentcastQuotaAllows } from "./rentcast-burn-rate";

describe("rentcastQuotaAllows", () => {
  it("allows when within per-run cap and remaining unknown", () => {
    const d = rentcastQuotaAllows({ estimatedRemaining: null, callsNeeded: 15, perRunCap: 30 });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("ok");
  });

  it("allows at the per-run cap boundary", () => {
    expect(rentcastQuotaAllows({ estimatedRemaining: null, callsNeeded: 30, perRunCap: 30 }).allowed).toBe(true);
  });

  it("denies when calls exceed per-run cap (hard gate)", () => {
    const d = rentcastQuotaAllows({ estimatedRemaining: 999, callsNeeded: 31, perRunCap: 30 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("exceeds_per_run_cap");
  });

  it("denies when weekly remaining below calls needed (soft gate)", () => {
    const d = rentcastQuotaAllows({ estimatedRemaining: 10, callsNeeded: 15, perRunCap: 30 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("insufficient_weekly_remaining");
  });

  it("allows when weekly remaining exactly equals calls needed", () => {
    expect(rentcastQuotaAllows({ estimatedRemaining: 15, callsNeeded: 15, perRunCap: 30 }).allowed).toBe(true);
  });

  it("per-run cap takes precedence over weekly check", () => {
    const d = rentcastQuotaAllows({ estimatedRemaining: 5, callsNeeded: 40, perRunCap: 30 });
    expect(d.reason).toBe("exceeds_per_run_cap");
  });

  it("ignores non-finite remaining (treats as unknown)", () => {
    expect(rentcastQuotaAllows({ estimatedRemaining: Number.NaN, callsNeeded: 15, perRunCap: 30 }).allowed).toBe(true);
  });
});
