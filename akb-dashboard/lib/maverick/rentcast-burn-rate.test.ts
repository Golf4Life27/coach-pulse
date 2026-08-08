// @agent: maverick — RentCast burn-rate synthesis tests.

import { describe, it, expect } from "vitest";
import { computeBurnRate, countRentcastPaidCalls, rentcastQuotaAllows, MIN_TRUSTED_WINDOW_HOURS } from "./rentcast-burn-rate";
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

describe("it refuses to page on a window too short to average the cron mix", () => {
  // TWICE NOW: 2026-08-05 and 2026-08-08, both "~0d to exhaustion" at Tier 3.
  const rc = rentcast({ monthly_cap: 1000 });
  const au = audit({ rentcast: 25 });

  it("returns null days on a 2h window even with a hot burst", () => {
    // 25 calls in 2h extrapolates to 300/day, which then eats the whole cap
    // 8 days into the cycle and divides down to 0.
    const r = computeBurnRate({ rentcast: rc, audit: au, windowHours: 2, daysElapsedInCycle: 8 });
    expect(r.burn_rate_per_day).toBe(300);
    expect(r.days_until_exhaustion_estimate).toBeNull();
  });

  it("projects normally once the window reaches 24h", () => {
    const r = computeBurnRate({ rentcast: rc, audit: au, windowHours: 24, daysElapsedInCycle: 8 });
    expect(r.days_until_exhaustion_estimate).not.toBeNull();
  });

  it("holds the threshold so a later edit argues with a test", () => {
    expect(MIN_TRUSTED_WINDOW_HOURS).toBe(24);
  });
});

describe("a REAL consumed figure beats the extrapolation", () => {
  const rc = rentcast({ monthly_cap: 1000 });
  const au = audit({ rentcast: 25 });

  it("uses the meter instead of rate x days-elapsed", () => {
    // Extrapolation would claim 300/day x 8 = 2,400 consumed -> 0 remaining.
    // The real meter says 120 used, so 880 remain.
    const r = computeBurnRate({
      rentcast: rc, audit: au, windowHours: 2, daysElapsedInCycle: 8, actualCallsUsedThisCycle: 120,
    });
    expect(r.estimated_calls_remaining).toBe(880);
    // With a solid remaining figure the projection is allowed even on 2h.
    expect(r.days_until_exhaustion_estimate).toBe(Math.floor(880 / 300));
  });

  it("a zero meter is honoured, not treated as missing", () => {
    const r = computeBurnRate({
      rentcast: rc, audit: au, windowHours: 24, daysElapsedInCycle: 8, actualCallsUsedThisCycle: 0,
    });
    expect(r.estimated_calls_remaining).toBe(1000);
  });
});

// 2026-08-08: the truncation regression. The KV audit source read only its
// newest page (200 events ≈ 3h on a busy day) while the aggregator claimed a
// 24h window — 30 calls / 24h reported "30/day, stabilized" while the honest
// 5,000-row counter read 197/24h. The clamp keys on read_truncated +
// oldest_event_ts: a truncated read's count only covers the span back to the
// oldest event it holds.
describe("a truncated audit read must not be rated over the claimed window", () => {
  const NOW = new Date("2026-08-08T18:00:00Z");
  const threeHoursAgo = "2026-08-08T15:00:00Z";

  it("clamps the window to the actual data span and reports the real burn", () => {
    const au = { ...audit({ rentcast: 30 }), read_truncated: true, oldest_event_ts: threeHoursAgo };
    const out = computeBurnRate({
      rentcast: rentcast(),
      audit: au,
      windowHours: 24,
      daysElapsedInCycle: 7,
      now: NOW,
    });
    expect(out.window_hours).toBe(3);
    expect(out.burn_rate_per_day).toBe(240); // 30 calls / 3h × 24 — not 30/day
    // 3h < MIN_TRUSTED_WINDOW_HOURS: too short to average the cron mix, so
    // no exhaustion projection — a loud "unknown" beats a false calm.
    expect(out.days_until_exhaustion_estimate).toBeNull();
  });

  it("does not clamp when the read was not truncated (recent oldest event just means low traffic)", () => {
    const au = { ...audit({ rentcast: 30 }), read_truncated: false, oldest_event_ts: threeHoursAgo };
    const out = computeBurnRate({
      rentcast: rentcast(),
      audit: au,
      windowHours: 24,
      daysElapsedInCycle: 7,
      now: NOW,
    });
    expect(out.window_hours).toBe(24);
    expect(out.burn_rate_per_day).toBe(30);
  });

  it("legacy states without the read_truncated field behave exactly as before", () => {
    const out = computeBurnRate({
      rentcast: rentcast(),
      audit: audit({ rentcast: 30 }),
      windowHours: 24,
      daysElapsedInCycle: 7,
      now: NOW,
    });
    expect(out.window_hours).toBe(24);
    expect(out.burn_rate_per_day).toBe(30);
  });

  it("a truncated read spanning the full window is left alone (clamp is a min, never a stretch)", () => {
    const au = {
      ...audit({ rentcast: 197 }),
      read_truncated: true,
      oldest_event_ts: "2026-08-07T17:00:00Z", // 25h ago — span exceeds claim
    };
    const out = computeBurnRate({
      rentcast: rentcast(),
      audit: au,
      windowHours: 24,
      daysElapsedInCycle: 7,
      now: NOW,
    });
    expect(out.window_hours).toBe(24);
    expect(out.burn_rate_per_day).toBe(197);
  });
});
