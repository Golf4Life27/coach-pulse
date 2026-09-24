// @agent: maverick — external-rentcast composer tests.

import { describe, it, expect } from "vitest";
import { composeRentCastState } from "./external-rentcast";

describe("external-rentcast composeRentCastState", () => {
  // Fixed 2026-09-24: reset_date_utc used to be the 1st of the next
  // calendar month — the "Oct 1 reset" false report. RentCast's own
  // dashboard runs the plan ~11th → ~11th, so the reset date is now the
  // next RENTCAST_BILLING_ANCHOR_DAY (spend-ceiling.ts).
  it("computes days_until_reset against the next billing anchor (the 11th), not the 1st", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 18, 0, 0)); // May 15 UTC — inside the May 11 period
    const r = composeRentCastState(true, 120, now);
    expect(r.reset_date_utc).toBe("2026-06-11");
    expect(r.days_until_reset).toBe(27);
    expect(r.api_responsive).toBe(true);
    expect(r.probe_latency_ms).toBe(120);
  });

  it("stays anchored on the 11th even on the last calendar day of the month", () => {
    const now = new Date(Date.UTC(2026, 4, 31, 18, 0, 0)); // May 31 UTC — still the May 11 period
    const r = composeRentCastState(true, 50, now);
    expect(r.reset_date_utc).toBe("2026-06-11");
    expect(r.days_until_reset).toBe(11);
  });

  it("propagates api_responsive=false from the probe outcome", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 18, 0, 0));
    const r = composeRentCastState(false, 3000, now);
    expect(r.api_responsive).toBe(false);
  });

  it("surfaces monthly_cap from env (defaults to 1000 in tests with no override)", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 18, 0, 0));
    const r = composeRentCastState(true, 100, now);
    expect(typeof r.monthly_cap).toBe("number");
    expect(r.monthly_cap).toBeGreaterThanOrEqual(0);
  });
});
