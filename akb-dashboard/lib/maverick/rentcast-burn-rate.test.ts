// @agent: maverick — RentCast burn-rate synthesis tests.

import { describe, it, expect } from "vitest";
import { computeBurnRate, countPricingAgentCalls } from "./rentcast-burn-rate";
import type { RentCastState } from "./sources/external-rentcast";
import type { VercelKvAuditState } from "./sources/vercel-kv-audit";

function rentcast(over: Partial<RentCastState> = {}): RentCastState {
  return {
    api_responsive: true,
    api_key_configured: true,
    monthly_cap: 1000,
    reset_date_utc: "2026-06-01",
    days_until_reset: 17,
    probe_latency_ms: 100,
    ...over,
  };
}

function audit(by: Record<string, number>): VercelKvAuditState {
  return {
    total_events_since: Object.values(by).reduce((a, b) => a + b, 0),
    recent_events_by_agent: by,
    recent_failures: [],
    oldest_event_ts: null,
    newest_event_ts: null,
  };
}

describe("countPricingAgentCalls", () => {
  it("sums events across pricing-agent + phase4a + phase4a-wrapper attribution variants", () => {
    expect(
      countPricingAgentCalls(
        audit({ "pricing-agent": 3, phase4a: 2, "phase4a-wrapper": 1, crier: 99 }),
      ),
    ).toBe(6);
  });

  it("returns 0 when no pricing-agent events present", () => {
    expect(countPricingAgentCalls(audit({ crier: 50, sentry: 30 }))).toBe(0);
  });

  it("returns 0 when audit is null (KV unreachable)", () => {
    expect(countPricingAgentCalls(null)).toBe(0);
  });
});

describe("computeBurnRate", () => {
  it("doubles audit call count to estimate RentCast quota burns", () => {
    const r = computeBurnRate({
      rentcast: rentcast(),
      audit: audit({ "pricing-agent": 5 }),
      windowHours: 24,
      daysElapsedInCycle: 0,
    });
    expect(r.pricing_calls_in_window).toBe(5);
    expect(r.estimated_calls_in_window).toBe(10);
  });

  it("projects burn-rate-per-day from the window observation", () => {
    const r = computeBurnRate({
      rentcast: rentcast(),
      audit: audit({ "pricing-agent": 10 }),
      windowHours: 24,
      daysElapsedInCycle: 0,
    });
    // 10 audit calls × 2 quota credits / 24h × 24h = 20 per day.
    expect(r.burn_rate_per_day).toBe(20);
  });

  it("scales burn-rate when the window is shorter than 24h", () => {
    const r = computeBurnRate({
      rentcast: rentcast(),
      audit: audit({ "pricing-agent": 5 }),
      windowHours: 6,
      daysElapsedInCycle: 0,
    });
    // 5 × 2 / 6h × 24h = 40 per day.
    expect(r.burn_rate_per_day).toBe(40);
  });

  it("computes days_until_exhaustion against estimated_calls_remaining", () => {
    const r = computeBurnRate({
      rentcast: rentcast({ monthly_cap: 1000 }),
      audit: audit({ "pricing-agent": 10 }), // 20/day burn
      windowHours: 24,
      daysElapsedInCycle: 5, // 5 × 20 = 100 consumed, 900 remaining
      // → days_until_exhaustion = floor(900 / 20) = 45
    });
    expect(r.estimated_calls_remaining).toBe(900);
    expect(r.days_until_exhaustion_estimate).toBe(45);
  });

  it("returns null days_until_exhaustion when burn rate is 0", () => {
    const r = computeBurnRate({
      rentcast: rentcast(),
      audit: audit({}),
      windowHours: 24,
      daysElapsedInCycle: 0,
    });
    expect(r.burn_rate_per_day).toBe(0);
    expect(r.days_until_exhaustion_estimate).toBeNull();
    expect(r.estimated_calls_remaining).toBe(1000);
  });

  it("clamps estimated_calls_remaining at 0 when over-consumed", () => {
    const r = computeBurnRate({
      rentcast: rentcast({ monthly_cap: 100 }),
      audit: audit({ "pricing-agent": 100 }), // 200/day
      windowHours: 24,
      daysElapsedInCycle: 5, // 5 × 200 = 1000 estimated consumed
    });
    expect(r.estimated_calls_remaining).toBe(0);
    expect(r.days_until_exhaustion_estimate).toBe(0);
  });

  it("handles null audit (KV unreachable) — burn rate goes to 0, remaining stays at cap", () => {
    const r = computeBurnRate({
      rentcast: rentcast(),
      audit: null,
      windowHours: 24,
      daysElapsedInCycle: 0,
    });
    expect(r.pricing_calls_in_window).toBe(0);
    expect(r.burn_rate_per_day).toBe(0);
    expect(r.estimated_calls_remaining).toBe(1000);
    expect(r.days_until_exhaustion_estimate).toBeNull();
  });
});
