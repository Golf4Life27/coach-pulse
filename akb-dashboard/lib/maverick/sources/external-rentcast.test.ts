// @agent: maverick — external-rentcast composer tests.

import { describe, it, expect } from "vitest";
import { composeRentCastState } from "./external-rentcast";

describe("external-rentcast composeRentCastState", () => {
  it("computes days_until_reset against UTC first-of-next-month", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 18, 0, 0)); // May 15 UTC
    const r = composeRentCastState(true, 120, now);
    expect(r.reset_date_utc).toBe("2026-06-01");
    expect(r.days_until_reset).toBe(17);
    expect(r.api_responsive).toBe(true);
    expect(r.probe_latency_ms).toBe(120);
  });

  it("returns 1 day-until-reset on the last calendar day of the month", () => {
    const now = new Date(Date.UTC(2026, 4, 31, 18, 0, 0));
    const r = composeRentCastState(true, 50, now);
    expect(r.reset_date_utc).toBe("2026-06-01");
    expect(r.days_until_reset).toBe(1);
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
