// @agent: maverick — RentCast burn-rate synthesis tests.

import { describe, it, expect } from "vitest";
import { computeBurnRate, countRentcastPaidCalls, rentcastQuotaAllows } from "./rentcast-burn-rate";
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
    recent_events: [],
    recent_failures: [],
    oldest_event_ts: null,
    newest_event_ts: null,
    mcp_call_latency: {
      samples: 0,
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
      by_tool: {},
      over_target_count: 0,
      p95_target_ms: 30_000,
    },
  };
}

// Consolidation Night 2026-07-29 (item C): the meter counts agent
// "rentcast" paid_api_call rows 1:1. The old three-agent-names-times-two
// heuristic was structurally blind to the crons doing ~90% of real spend
// (vendor billed ~231/day while this meter read near zero).
describe("countRentcastPaidCalls", () => {
  it("counts the rentcast agent's audit rows, ignoring every other agent", () => {
    expect(
      countRentcastPaidCalls(
        audit({ rentcast: 135, "pricing-agent": 3, phase4a: 2, crier: 99 }),
      ),
    ).toBe(135);
  });

  it("no longer counts legacy pricing-agent names (their calls audit as rentcast now)", () => {
    expect(
      countRentcastPaidCalls(audit({ "pricing-agent": 3, phase4a: 2, "phase4a-wrapper": 1 })),
    ).toBe(0);
  });

  it("returns 0 when audit is null (KV unreachable)", () => {
    expect(countRentcastPaidCalls(null)).toBe(0);
  });
});

describe("rentcastQuotaAllows — overage semantics (honest meter)", () => {
  it("hard per-run cap still denies regardless of pacing", () => {
    const d = rentcastQuotaAllows({ estimatedRemaining: 500, callsNeeded: 20, perRunCap: 10, governorPaced: true });
    expect(d).toMatchObject({ allowed: false, reason: "exceeds_per_run_cap" });
  });

  it("non-governor caller is denied on insufficient remaining (unchanged)", () => {
    const d = rentcastQuotaAllows({ estimatedRemaining: 0, callsNeeded: 5, perRunCap: 10 });
    expect(d).toMatchObject({ allowed: false, reason: "insufficient_weekly_remaining" });
  });

  it("governor-paced caller CONTINUES in overage, loudly labeled", () => {
    // Mid-cycle overage: remaining is honestly 0, but the daily governor
    // already paces forward spend — halting the funnel would trade deal
    // flow for ~1.2 cents/call.
    const d = rentcastQuotaAllows({ estimatedRemaining: 0, callsNeeded: 5, perRunCap: 10, governorPaced: true });
    expect(d).toMatchObject({ allowed: true, reason: "overage_continue_governor_paced" });
  });

  it("governor-paced with sufficient remaining is a plain ok", () => {
    const d = rentcastQuotaAllows({ estimatedRemaining: 500, callsNeeded: 5, perRunCap: 10, governorPaced: true });
    expect(d).toMatchObject({ allowed: true, reason: "ok" });
  });

  it("unknown remaining (null) skips the soft check", () => {
    const d = rentcastQuotaAllows({ estimatedRemaining: null, callsNeeded: 5, perRunCap: 10 });
    expect(d).toMatchObject({ allowed: true, reason: "ok" });
  });
});

describe("computeBurnRate", () => {
  it("counts paid calls 1:1 — the x2 pricing-agent heuristic is retired", () => {
    const r = computeBurnRate({
      rentcast: rentcast(),
      audit: audit({ rentcast: 5 }),
      windowHours: 24,
      daysElapsedInCycle: 0,
    });
    expect(r.paid_calls_in_window).toBe(5);
    expect(r.estimated_calls_in_window).toBe(5);
  });

  it("projects burn-rate-per-day from the window observation", () => {
    const r = computeBurnRate({
      rentcast: rentcast(),
      audit: audit({ rentcast: 20 }),
      windowHours: 24,
      daysElapsedInCycle: 0,
    });
    // 20 paid calls / 24h × 24h = 20 per day. Honest 1:1.
    expect(r.burn_rate_per_day).toBe(20);
  });

  it("scales burn-rate when the window is shorter than 24h", () => {
    const r = computeBurnRate({
      rentcast: rentcast(),
      audit: audit({ rentcast: 10 }),
      windowHours: 6,
      daysElapsedInCycle: 0,
    });
    // 10 / 6h × 24h = 40 per day.
    expect(r.burn_rate_per_day).toBe(40);
  });

  it("computes days_until_exhaustion against estimated_calls_remaining", () => {
    const r = computeBurnRate({
      rentcast: rentcast({ monthly_cap: 1000 }),
      audit: audit({ rentcast: 20 }), // 20/day burn
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
      audit: audit({ rentcast: 200 }), // 200/day
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
    expect(r.paid_calls_in_window).toBe(0);
    expect(r.burn_rate_per_day).toBe(0);
    expect(r.estimated_calls_remaining).toBe(1000);
    expect(r.days_until_exhaustion_estimate).toBeNull();
  });
});
