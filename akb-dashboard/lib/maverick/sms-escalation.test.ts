// @agent: maverick — Stage 4 SMS escalation tests (Phase 9.7).

import { describe, it, expect, vi } from "vitest";
import {
  deriveSignalKey,
  formatStage4Message,
  parseDailySends,
  pruneRecentSends,
  evaluateStage4Escalation,
  type Stage4Env,
} from "./sms-escalation";
import { makeMemoryKv } from "./oauth/kv";
import type { PrioritySignal, SeverityTier } from "./severity";
import type { StructuredBriefing, SourceHealth } from "./briefing";
import type { SourceName } from "./types";

const ENV: Stage4Env = { target: "+16302505865", cooldownMin: 30, dailyCap: 5 };
const NOW = new Date("2026-05-18T12:00:00Z");

function signal(over: Partial<PrioritySignal> & { tier: SeverityTier; id: string }): PrioritySignal {
  return {
    title: "Test signal",
    reason: null,
    agent: null,
    href: null,
    ...over,
  };
}

function emptySourceHealth(): Record<SourceName, SourceHealth> {
  const sources: SourceName[] = [
    "git",
    "airtable_listings",
    "airtable_spine",
    "vercel_kv_audit",
    "codebase_metadata",
    "action_queue",
    "external_rentcast",
    "external_quo",
    "external_vercel",
    "external_docusign",
  ];
  const out = {} as Record<SourceName, SourceHealth>;
  for (const s of sources) {
    out[s] = {
      source: s,
      ok: true,
      latency_ms: 0,
      staleness_seconds: 0,
      served_from_cache: false,
      error: null,
    };
  }
  return out;
}

function briefingFixture(
  over: Partial<StructuredBriefing> = {},
): Pick<StructuredBriefing, "audit_summary" | "active_deals" | "open_decisions" | "recent_key_decisions" | "external_signals" | "staleness_warnings"> {
  return {
    audit_summary: {
      total_events_since: 0,
      by_agent: {},
      recent_events: [],
      recent_failures: [],
      mcp_call_latency: {
        samples: 0,
        p50_ms: null,
        p95_ms: null,
        p99_ms: null,
        by_tool: {},
        over_target_count: 0,
        p95_target_ms: 30_000,
      },
    },
    active_deals: [],
    open_decisions: [],
    recent_key_decisions: [],
    external_signals: {
      rentcast: {
        api_responsive: true,
        api_key_configured: true,
        monthly_cap: 1000,
        reset_date_utc: "",
        days_until_reset: 14,
        probe_latency_ms: 0,
        burn_rate: {
          pricing_calls_in_window: 0,
          estimated_calls_in_window: 0,
          window_hours: 24,
          burn_rate_per_day: 0,
          days_until_exhaustion_estimate: null,
          estimated_calls_remaining: 1000,
        },
      },
      quo: { api_responsive: true, api_key_configured: true, most_recent_outbound_at: null, most_recent_inbound_at: null, messages_last_24h: 0 },
      vercel: {
        api_token_configured: false,
        production_deploy_id: null,
        production_deploy_url: null,
        production_deploy_state: "UNKNOWN",
        production_deploy_sha: null,
        production_deploy_short_sha: null,
        production_deploy_branch: null,
        production_deploy_ready_at: null,
        production_deploy_created_at: null,
        active_branch_observed: "",
      },
      docusign: {
        configured: false,
        api_reachable: false,
        rollup: { active_count: 0, awaiting_alex_count: 0, signed_this_week: 0, voided_or_expired: 0, max_awaiting_alex_hours: null },
        envelopes: [],
        fetched_at: "",
      },
    },
    staleness_warnings: [],
    ...over,
  };
}

// All sources down → severity.ts emits a tier-3 sources_down_critical
// signal. Build a fixture that triggers it.
function briefingWithTier3SourcesDown(): {
  briefing: ReturnType<typeof briefingFixture>;
  source_health: Record<SourceName, SourceHealth>;
} {
  const sh = emptySourceHealth();
  for (const s of Object.keys(sh) as SourceName[]) {
    sh[s] = { ...sh[s], ok: false, error: "timeout" };
  }
  return { briefing: briefingFixture(), source_health: sh };
}

// RentCast burn ≤3 days → tier 3 rentcast_exhaustion_imminent.
function briefingWithRentcastBurn(): {
  briefing: ReturnType<typeof briefingFixture>;
  source_health: Record<SourceName, SourceHealth>;
} {
  const b = briefingFixture({
    external_signals: {
      rentcast: {
        api_responsive: true,
        api_key_configured: true,
        monthly_cap: 1000,
        reset_date_utc: "",
        days_until_reset: 14,
        probe_latency_ms: 0,
        burn_rate: {
          pricing_calls_in_window: 800,
          estimated_calls_in_window: 800,
          window_hours: 24,
          burn_rate_per_day: 800,
          days_until_exhaustion_estimate: 2,
          estimated_calls_remaining: 200,
        },
      },
      quo: { api_responsive: true, api_key_configured: true, most_recent_outbound_at: null, most_recent_inbound_at: null, messages_last_24h: 0 },
      vercel: {
        api_token_configured: false,
        production_deploy_id: null,
        production_deploy_url: null,
        production_deploy_state: "UNKNOWN",
        production_deploy_sha: null,
        production_deploy_short_sha: null,
        production_deploy_branch: null,
        production_deploy_ready_at: null,
        production_deploy_created_at: null,
        active_branch_observed: "",
      },
      docusign: {
        configured: false,
        api_reachable: false,
        rollup: { active_count: 0, awaiting_alex_count: 0, signed_this_week: 0, voided_or_expired: 0, max_awaiting_alex_hours: null },
        envelopes: [],
        fetched_at: "",
      },
    },
  });
  return { briefing: b, source_health: emptySourceHealth() };
}

describe("deriveSignalKey", () => {
  it("uses the signal id when present", () => {
    expect(deriveSignalKey(signal({ tier: 3, id: "rentcast_exhaustion_imminent" })))
      .toBe("rentcast_exhaustion_imminent");
  });

  it("sanitizes unsafe characters in the id", () => {
    const r = deriveSignalKey(signal({ tier: 3, id: "failure_2026-05-18T12:00:00Z_crier" }));
    expect(r).not.toContain("/");
    expect(r).toContain("crier");
  });

  it("produces stable keys for the same signal across calls", () => {
    const s = signal({ tier: 3, id: "x" });
    expect(deriveSignalKey(s)).toBe(deriveSignalKey(s));
  });
});

describe("formatStage4Message", () => {
  it("includes the Maverick TIER 3 prefix + title", () => {
    const m = formatStage4Message(
      signal({ tier: 3, id: "x", title: "RentCast exhausts in ~2d" }),
    );
    expect(m).toContain("🐕 Maverick — TIER 3");
    expect(m).toContain("RentCast exhausts in ~2d");
  });

  it("appends reason on its own line when present", () => {
    const m = formatStage4Message(
      signal({ tier: 3, id: "x", title: "x", reason: "Throttle now" }),
    );
    expect(m).toContain("Throttle now");
  });

  it("appends the agent attribution in @UPPER format", () => {
    const m = formatStage4Message(
      signal({ tier: 3, id: "x", title: "x", agent: "appraiser" }),
    );
    expect(m).toContain("@APPRAISER");
  });

  it("truncates very long reason text to keep SMS scannable", () => {
    const long = "x".repeat(500);
    const m = formatStage4Message(signal({ tier: 3, id: "x", title: "y", reason: long }));
    expect(m.length).toBeLessThan(500);
  });
});

describe("parseDailySends", () => {
  it("returns [] for null input", () => {
    expect(parseDailySends(null)).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseDailySends("not-json")).toEqual([]);
  });

  it("returns [] when parsed value is not an array", () => {
    expect(parseDailySends('{"foo": "bar"}')).toEqual([]);
  });

  it("filters out non-string entries", () => {
    expect(parseDailySends('["2026-05-18T12:00:00Z", 42, null]')).toEqual([
      "2026-05-18T12:00:00Z",
    ]);
  });
});

describe("pruneRecentSends", () => {
  it("drops entries older than the rolling window", () => {
    // NOW = 2026-05-18T12:00:00Z. 24h cutoff = 2026-05-17T12:00:00Z.
    const sends = [
      "2026-05-18T11:00:00Z", // 1h ago — inside
      "2026-05-17T13:00:00Z", // 23h ago — inside
      "2026-05-17T11:00:00Z", // 25h ago — outside
      "2026-05-16T11:00:00Z", // 49h ago — outside
    ];
    const r = pruneRecentSends(sends, NOW);
    expect(r).toContain("2026-05-18T11:00:00Z");
    expect(r).toContain("2026-05-17T13:00:00Z");
    expect(r).not.toContain("2026-05-17T11:00:00Z");
    expect(r).not.toContain("2026-05-16T11:00:00Z");
  });

  it("sorts newest first", () => {
    const sends = ["2026-05-18T08:00:00Z", "2026-05-18T11:00:00Z"];
    const r = pruneRecentSends(sends, NOW);
    expect(r[0]).toBe("2026-05-18T11:00:00Z");
  });

  it("returns [] when all entries are stale", () => {
    expect(pruneRecentSends(["2026-05-10T00:00:00Z"], NOW)).toEqual([]);
  });
});

describe("evaluateStage4Escalation — auth gating", () => {
  it("is a no-op for cron callers", async () => {
    const send = vi.fn();
    const fix = briefingWithTier3SourcesDown();
    const r = await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "cron",
      kv: makeMemoryKv(),
      env: ENV,
      now: NOW,
      send,
      recordAudit: async () => {},
    });
    expect(r.attempted).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("is a no-op for bearer_dev callers", async () => {
    const send = vi.fn();
    const fix = briefingWithTier3SourcesDown();
    const r = await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "bearer_dev",
      kv: makeMemoryKv(),
      env: ENV,
      now: NOW,
      send,
      recordAudit: async () => {},
    });
    expect(r.attempted).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("is a no-op for unauthenticated callers", async () => {
    const send = vi.fn();
    const fix = briefingWithTier3SourcesDown();
    const r = await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "none",
      kv: makeMemoryKv(),
      env: ENV,
      now: NOW,
      send,
      recordAudit: async () => {},
    });
    expect(r.attempted).toBe(0);
  });
});

describe("evaluateStage4Escalation — tier filtering", () => {
  it("does NOT fire when no tier-3 signals exist (clean briefing)", async () => {
    const send = vi.fn();
    const r = await evaluateStage4Escalation({
      briefing: briefingFixture(),
      source_health: emptySourceHealth(),
      authKind: "dashboard_session",
      kv: makeMemoryKv(),
      env: ENV,
      now: NOW,
      send,
      recordAudit: async () => {},
    });
    expect(r.attempted).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("fires when a tier-3 sources-down signal is present", async () => {
    const send = vi.fn().mockResolvedValue({
      id: "msg_123",
      status: "queued",
      httpStatus: 202,
      raw: {},
    });
    const fix = briefingWithTier3SourcesDown();
    const r = await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "dashboard_session",
      kv: makeMemoryKv(),
      env: ENV,
      now: NOW,
      send,
      recordAudit: async () => {},
    });
    expect(r.sent).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe("+16302505865");
    expect(send.mock.calls[0][1]).toContain("TIER 3");
  });
});

describe("evaluateStage4Escalation — dedup (per-signal cooldown)", () => {
  it("sends once across 3 consecutive evaluations of the same signal", async () => {
    const send = vi.fn().mockResolvedValue({ id: "m1", status: "queued", httpStatus: 202, raw: {} });
    const kv = makeMemoryKv();
    const fix = briefingWithRentcastBurn();
    for (let i = 0; i < 3; i++) {
      await evaluateStage4Escalation({
        briefing: fix.briefing,
        source_health: fix.source_health,
        authKind: "dashboard_session",
        kv,
        env: ENV,
        now: new Date(NOW.getTime() + i * 60_000), // 1m apart
        send,
        recordAudit: async () => {},
      });
    }
    expect(send).toHaveBeenCalledOnce();
  });

  it("re-sends after cooldown expires (KV key absent)", async () => {
    // The in-memory KV's TTL uses wall-clock Date.now() rather than
    // our virtual `now`, so we simulate cooldown expiration by
    // deleting the dedup key between evaluations. The production KV's
    // setEx-with-TTL handles the equivalent expiration in real time.
    const send = vi.fn().mockResolvedValue({ id: "m", status: "queued", httpStatus: 202, raw: {} });
    const kv = makeMemoryKv();
    const fix = briefingWithRentcastBurn();
    await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "dashboard_session",
      kv,
      env: ENV,
      now: NOW,
      send,
      recordAudit: async () => {},
    });
    expect(send).toHaveBeenCalledTimes(1);

    // Simulate KV TTL expiry by clearing the cooldown key.
    await kv.del("mav:sms:signal:rentcast_exhaustion_imminent");

    const later = new Date(NOW.getTime() + 31 * 60_000);
    await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "dashboard_session",
      kv,
      env: ENV,
      now: later,
      send,
      recordAudit: async () => {},
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("evaluateStage4Escalation — daily rolling cap", () => {
  it("first N sends fire, N+1th suppressed and logged", async () => {
    const send = vi.fn().mockResolvedValue({ id: "m", status: "queued", httpStatus: 202, raw: {} });
    const kv = makeMemoryKv();
    const audits: Array<Record<string, unknown>> = [];
    const audit = async (e: Record<string, unknown>) => { audits.push(e); };

    // 6 distinct signal IDs, each tier 3 — fake by injecting a custom
    // signal source via repeated runs with distinct briefings would be
    // complex. Instead, pre-seed the daily-sends KV with 5 entries from
    // within the last hour and trigger one new tier-3 — should suppress.
    await kv.setEx(
      "mav:sms:daily:sends",
      JSON.stringify([
        new Date(NOW.getTime() - 1 * 60_000).toISOString(),
        new Date(NOW.getTime() - 2 * 60_000).toISOString(),
        new Date(NOW.getTime() - 3 * 60_000).toISOString(),
        new Date(NOW.getTime() - 4 * 60_000).toISOString(),
        new Date(NOW.getTime() - 5 * 60_000).toISOString(),
      ]),
      24 * 60 * 60,
    );

    const fix = briefingWithRentcastBurn();
    const r = await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "dashboard_session",
      kv,
      env: ENV,
      now: NOW,
      send,
      recordAudit: audit,
    });
    expect(r.suppressed_daily_cap).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(audits.some((a) => a.event === "sms_rate_limited" && (a.inputSummary as Record<string, unknown>).reason === "daily_cap")).toBe(true);
  });

  it("entries older than 24h are pruned and don't count against the cap", async () => {
    const send = vi.fn().mockResolvedValue({ id: "m", status: "queued", httpStatus: 202, raw: {} });
    const kv = makeMemoryKv();
    // 5 entries, all > 24h ago — should all prune.
    await kv.setEx(
      "mav:sms:daily:sends",
      JSON.stringify([
        new Date(NOW.getTime() - 25 * 60 * 60_000).toISOString(),
        new Date(NOW.getTime() - 26 * 60 * 60_000).toISOString(),
        new Date(NOW.getTime() - 27 * 60 * 60_000).toISOString(),
        new Date(NOW.getTime() - 28 * 60 * 60_000).toISOString(),
        new Date(NOW.getTime() - 29 * 60 * 60_000).toISOString(),
      ]),
      24 * 60 * 60,
    );
    const fix = briefingWithRentcastBurn();
    const r = await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "dashboard_session",
      kv,
      env: ENV,
      now: NOW,
      send,
      recordAudit: async () => {},
    });
    expect(r.sent).toBe(1);
  });
});

describe("evaluateStage4Escalation — Quo API failure handling", () => {
  it("logs failure as audit + does not throw to caller", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Quo 502 Bad Gateway"));
    const audits: Array<Record<string, unknown>> = [];
    const fix = briefingWithRentcastBurn();
    const r = await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "dashboard_session",
      kv: makeMemoryKv(),
      env: ENV,
      now: NOW,
      send,
      recordAudit: async (e) => { audits.push(e); },
    });
    expect(r.failed).toBe(1);
    expect(r.sent).toBe(0);
    expect(audits.some((a) => a.event === "sms_escalation_failed" && a.status === "confirmed_failure")).toBe(true);
  });

  it("does NOT write dedup KV key on Quo failure — next briefing retries", async () => {
    const send = vi.fn().mockRejectedValue(new Error("fail"));
    const kv = makeMemoryKv();
    const fix = briefingWithRentcastBurn();
    await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "dashboard_session",
      kv,
      env: ENV,
      now: NOW,
      send,
      recordAudit: async () => {},
    });
    // The signal key should NOT have been set — retry must be permitted.
    expect(await kv.get("mav:sms:signal:rentcast_exhaustion_imminent")).toBeNull();

    // Now succeed on retry.
    send.mockResolvedValue({ id: "ok", status: "queued", httpStatus: 202, raw: {} });
    const r = await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "dashboard_session",
      kv,
      env: ENV,
      now: new Date(NOW.getTime() + 90_000),
      send,
      recordAudit: async () => {},
    });
    expect(r.sent).toBe(1);
  });
});

describe("evaluateStage4Escalation — audit telemetry", () => {
  it("emits sms_escalation_sent on successful send with quo_message_id", async () => {
    const send = vi.fn().mockResolvedValue({
      id: "quo_msg_abc",
      status: "queued",
      httpStatus: 202,
      raw: {},
    });
    const audits: Array<Record<string, unknown>> = [];
    const fix = briefingWithRentcastBurn();
    await evaluateStage4Escalation({
      briefing: fix.briefing,
      source_health: fix.source_health,
      authKind: "dashboard_session",
      kv: makeMemoryKv(),
      env: ENV,
      now: NOW,
      send,
      recordAudit: async (e) => { audits.push(e); },
    });
    const entry = audits.find((a) => a.event === "sms_escalation_sent");
    expect(entry).toBeDefined();
    expect(entry?.agent).toBe("crier");
    expect((entry?.outputSummary as Record<string, unknown>).quo_message_id).toBe(
      "quo_msg_abc",
    );
  });
});
