// @agent: maverick — vercel-kv-audit summarizer tests.

import { describe, it, expect } from "vitest";
import { summarizeEvents } from "./vercel-kv-audit";
import type { AuditEntry } from "@/lib/audit-log";

function evt(over: Partial<AuditEntry> & { ts: string; agent: string; event: string; status: AuditEntry["status"] }): AuditEntry {
  return { ...over } as AuditEntry;
}

describe("vercel-kv-audit summarizeEvents", () => {
  it("groups events by agent and counts them", () => {
    const events: AuditEntry[] = [
      evt({ ts: "2026-05-15T00:00:00Z", agent: "crier", event: "send", status: "confirmed_success" }),
      evt({ ts: "2026-05-15T00:01:00Z", agent: "crier", event: "send", status: "confirmed_success" }),
      evt({ ts: "2026-05-15T00:02:00Z", agent: "sentry", event: "gate", status: "confirmed_success" }),
    ];
    const r = summarizeEvents(events);
    expect(r.total_events_since).toBe(3);
    expect(r.recent_events_by_agent).toEqual({ crier: 2, sentry: 1 });
  });

  it("isolates confirmed_failure events into recent_failures with attribution", () => {
    const events: AuditEntry[] = [
      evt({
        ts: "2026-05-15T00:00:00Z",
        agent: "crier",
        event: "send_failed",
        status: "confirmed_failure",
        error: "Quo 502",
        recordId: "recABC",
      }),
      evt({ ts: "2026-05-15T00:01:00Z", agent: "appraiser", event: "rentcast", status: "confirmed_success" }),
    ];
    const r = summarizeEvents(events);
    expect(r.recent_failures).toHaveLength(1);
    expect(r.recent_failures[0]).toMatchObject({
      agent: "crier",
      event: "send_failed",
      error: "Quo 502",
      recordId: "recABC",
    });
  });

  it("applies the since filter and excludes earlier events", () => {
    const events: AuditEntry[] = [
      evt({ ts: "2026-05-15T00:00:00Z", agent: "crier", event: "send", status: "confirmed_success" }),
      evt({ ts: "2026-05-13T00:00:00Z", agent: "crier", event: "send", status: "confirmed_success" }),
    ];
    const r = summarizeEvents(events, new Date("2026-05-14T00:00:00Z"));
    expect(r.total_events_since).toBe(1);
  });

  it("handles empty input cleanly", () => {
    const r = summarizeEvents([]);
    expect(r.total_events_since).toBe(0);
    expect(r.recent_events_by_agent).toEqual({});
    expect(r.recent_failures).toEqual([]);
    expect(r.oldest_event_ts).toBeNull();
    expect(r.newest_event_ts).toBeNull();
  });

  it("caps recent_failures at 25 even with a large failure burst", () => {
    const events: AuditEntry[] = Array.from({ length: 50 }, (_, i) =>
      evt({
        ts: `2026-05-15T00:00:${String(i).padStart(2, "0")}Z`,
        agent: "crier",
        event: "send_failed",
        status: "confirmed_failure",
      }),
    );
    const r = summarizeEvents(events);
    expect(r.recent_failures).toHaveLength(25);
  });
});
