// @agent: maverick — factory-floor agent-room data shaping tests.

import { describe, it, expect } from "vitest";
import { summarizeAgentActivity, formatRelativeTs } from "./agent-room";
import type { StructuredBriefing } from "./briefing";
import type { RecentAuditEvent } from "./sources/vercel-kv-audit";

function event(over: Partial<RecentAuditEvent> & { agent: string; ts: string }): RecentAuditEvent {
  return {
    event: "tick",
    status: "confirmed_success",
    recordId: null,
    ...over,
  };
}

function briefing(events: RecentAuditEvent[], byAgent: Record<string, number> = {}): Pick<StructuredBriefing, "audit_summary"> {
  const computedByAgent: Record<string, number> = { ...byAgent };
  if (Object.keys(byAgent).length === 0) {
    for (const e of events) {
      computedByAgent[e.agent] = (computedByAgent[e.agent] ?? 0) + 1;
    }
  }
  return {
    audit_summary: {
      total_events_since: events.length,
      by_agent: computedByAgent,
      recent_events: events,
      recent_failures: events
        .filter((e) => e.status === "confirmed_failure")
        .map((e) => ({
          agent: e.agent,
          event: e.event,
          error: null,
          recordId: e.recordId,
          ts: e.ts,
        })),
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
  };
}

describe("summarizeAgentActivity", () => {
  it("returns tier 0 + active=false when agent has no events", () => {
    const b = briefing([
      event({ agent: "crier", ts: "2026-05-17T00:00:00Z" }),
    ]);
    const r = summarizeAgentActivity(b, "scribe");
    expect(r.tier).toBe(0);
    expect(r.active).toBe(false);
    expect(r.recent_events).toEqual([]);
    expect(r.newest_ts).toBeNull();
    expect(r.failure_count).toBe(0);
  });

  it("returns tier 1 when agent has successful events only", () => {
    const b = briefing([
      event({ agent: "crier", ts: "2026-05-17T00:00:00Z", status: "confirmed_success" }),
      event({ agent: "crier", ts: "2026-05-17T00:01:00Z", status: "confirmed_success" }),
    ]);
    const r = summarizeAgentActivity(b, "crier");
    expect(r.tier).toBe(1);
    expect(r.active).toBe(true);
    expect(r.recent_events).toHaveLength(2);
    expect(r.failure_count).toBe(0);
  });

  it("returns tier 1 when agent has uncertain events but no failures", () => {
    const b = briefing([
      event({ agent: "crier", ts: "2026-05-17T00:00:00Z", status: "uncertain" }),
    ]);
    const r = summarizeAgentActivity(b, "crier");
    expect(r.tier).toBe(1);
    expect(r.uncertain_count).toBe(1);
  });

  it("escalates to tier 2 when agent has any confirmed_failure", () => {
    const b = briefing([
      event({ agent: "crier", ts: "2026-05-17T00:00:00Z", status: "confirmed_success" }),
      event({ agent: "crier", ts: "2026-05-17T00:01:00Z", status: "confirmed_failure" }),
    ]);
    const r = summarizeAgentActivity(b, "crier");
    expect(r.tier).toBe(2);
    expect(r.failure_count).toBe(1);
  });

  it("filters recent_events strictly to the named agent", () => {
    const b = briefing([
      event({ agent: "crier", ts: "2026-05-17T00:00:00Z" }),
      event({ agent: "sentry", ts: "2026-05-17T00:01:00Z" }),
      event({ agent: "crier", ts: "2026-05-17T00:02:00Z" }),
    ]);
    const r = summarizeAgentActivity(b, "crier");
    expect(r.recent_events).toHaveLength(2);
    expect(r.recent_events.every((e) => e.agent === "crier")).toBe(true);
  });

  it("caps recent_events at the configured limit (default 5)", () => {
    const events: RecentAuditEvent[] = Array.from({ length: 10 }, (_, i) =>
      event({ agent: "crier", ts: `2026-05-17T00:00:${String(i).padStart(2, "0")}Z` }),
    );
    const b = briefing(events);
    expect(summarizeAgentActivity(b, "crier").recent_events).toHaveLength(5);
    expect(summarizeAgentActivity(b, "crier", { recentLimit: 3 }).recent_events).toHaveLength(3);
  });

  it("uses total_events from by_agent rollup, not just the recent slice", () => {
    // by_agent reflects the FULL window count; recent_events is capped at 50.
    const events: RecentAuditEvent[] = [
      event({ agent: "crier", ts: "2026-05-17T00:00:00Z" }),
    ];
    const b = briefing(events, { crier: 247 });
    expect(summarizeAgentActivity(b, "crier").total_events).toBe(247);
  });

  it("newest_ts is the most recent event for the agent", () => {
    const b = briefing([
      event({ agent: "crier", ts: "2026-05-17T00:05:00Z" }),
      event({ agent: "crier", ts: "2026-05-17T00:01:00Z" }),
    ]);
    expect(summarizeAgentActivity(b, "crier").newest_ts).toBe("2026-05-17T00:05:00Z");
  });
});

describe("formatRelativeTs", () => {
  const now = new Date("2026-05-17T12:00:00Z");

  it("returns 'just now' for sub-minute deltas", () => {
    expect(formatRelativeTs("2026-05-17T11:59:30Z", now)).toBe("just now");
  });

  it("returns 'Nm ago' for minute-scale deltas", () => {
    expect(formatRelativeTs("2026-05-17T11:55:00Z", now)).toBe("5m ago");
  });

  it("returns 'Nh ago' for hour-scale deltas", () => {
    expect(formatRelativeTs("2026-05-17T09:00:00Z", now)).toBe("3h ago");
  });

  it("returns 'Nd ago' for day-scale deltas", () => {
    expect(formatRelativeTs("2026-05-15T12:00:00Z", now)).toBe("2d ago");
  });

  it("handles future timestamps as 'just now' (clock skew tolerance)", () => {
    expect(formatRelativeTs("2026-05-17T12:01:00Z", now)).toBe("just now");
  });

  it("returns the raw string when the timestamp is unparseable", () => {
    expect(formatRelativeTs("not-a-date", now)).toBe("not-a-date");
  });
});
