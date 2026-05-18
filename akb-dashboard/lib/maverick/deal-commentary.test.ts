// @agent: maverick — deal-commentary inference tests.

import { describe, it, expect } from "vitest";
import {
  inferDealCommentary,
  filterEventsForDeal,
  type DealCommentaryListing,
} from "./deal-commentary";
import type { StructuredBriefing } from "./briefing";
import type { RecentAuditEvent } from "./sources/vercel-kv-audit";

const NOW = new Date("2026-05-17T12:00:00Z");

function listing(over: Partial<DealCommentaryListing> = {}): DealCommentaryListing {
  return {
    outreachStatus: null,
    lastOutreachDate: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    ...over,
  };
}

function briefing(events: RecentAuditEvent[]): Pick<StructuredBriefing, "audit_summary"> {
  return {
    audit_summary: {
      total_events_since: events.length,
      by_agent: {},
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

describe("filterEventsForDeal", () => {
  it("returns events matching the recordId", () => {
    const events: RecentAuditEvent[] = [
      { agent: "crier", event: "send", status: "confirmed_success", ts: "2026-05-17T10:00:00Z", recordId: "recA" },
      { agent: "crier", event: "send", status: "confirmed_success", ts: "2026-05-17T11:00:00Z", recordId: "recB" },
      { agent: "sentry", event: "gate", status: "confirmed_success", ts: "2026-05-17T11:30:00Z", recordId: "recA" },
    ];
    expect(filterEventsForDeal(briefing(events), "recA")).toHaveLength(2);
    expect(filterEventsForDeal(briefing(events), "recB")).toHaveLength(1);
    expect(filterEventsForDeal(briefing(events), "recC")).toHaveLength(0);
  });

  it("returns [] when briefing is null", () => {
    expect(filterEventsForDeal(null, "recA")).toEqual([]);
  });
});

describe("inferDealCommentary — Crier silence rules", () => {
  it("returns [] when status is not Negotiating or Response Received", () => {
    const r = inferDealCommentary(
      briefing([]),
      "recA",
      listing({ outreachStatus: "Texted", lastInboundAt: "2026-04-01T00:00:00Z" }),
      NOW,
    );
    expect(r).toEqual([]);
  });

  it("escalates to tier 2 after 14+ days of silence on a Negotiating deal", () => {
    const r = inferDealCommentary(
      briefing([]),
      "recA",
      listing({
        outreachStatus: "Negotiating",
        lastInboundAt: "2026-04-01T00:00:00Z", // 46 days ago
      }),
      NOW,
    );
    expect(r).toHaveLength(1);
    expect(r[0].tier).toBe(2);
    expect(r[0].agent).toBe("crier");
    expect(r[0].headline).toContain("46 days");
  });

  it("uses tier 1 for 7–13 days of silence", () => {
    const r = inferDealCommentary(
      briefing([]),
      "recA",
      listing({
        outreachStatus: "Negotiating",
        lastInboundAt: "2026-05-07T12:00:00Z", // 10 days ago
      }),
      NOW,
    );
    expect(r).toHaveLength(1);
    expect(r[0].tier).toBe(1);
    expect(r[0].headline).toContain("10 days");
  });

  it("does not fire silence signal when activity is recent (< 7 days)", () => {
    const r = inferDealCommentary(
      briefing([]),
      "recA",
      listing({
        outreachStatus: "Negotiating",
        lastInboundAt: "2026-05-15T12:00:00Z", // 2 days ago
      }),
      NOW,
    );
    expect(r).toEqual([]);
  });

  it("falls back to lastOutboundAt then lastOutreachDate when lastInboundAt is null", () => {
    const r = inferDealCommentary(
      briefing([]),
      "recA",
      listing({
        outreachStatus: "Response Received",
        lastInboundAt: null,
        lastOutboundAt: null,
        lastOutreachDate: "2026-04-15T00:00:00Z", // 32 days ago
      }),
      NOW,
    );
    expect(r).toHaveLength(1);
    expect(r[0].tier).toBe(2);
  });
});

describe("inferDealCommentary — failure surfacing", () => {
  it("surfaces failures attributed to this deal at tier 2", () => {
    const events: RecentAuditEvent[] = [
      { agent: "crier", event: "send_failed", status: "confirmed_failure", ts: "2026-05-17T10:00:00Z", recordId: "recA" },
    ];
    const r = inferDealCommentary(
      briefing(events),
      "recA",
      listing({ outreachStatus: "Texted" }),
      NOW,
    );
    expect(r).toHaveLength(1);
    expect(r[0].tier).toBe(2);
    expect(r[0].headline).toContain("send_failed");
  });

  it("does NOT surface failures attributed to other deals", () => {
    const events: RecentAuditEvent[] = [
      { agent: "crier", event: "send_failed", status: "confirmed_failure", ts: "2026-05-17T10:00:00Z", recordId: "recB" },
    ];
    const r = inferDealCommentary(briefing(events), "recA", listing(), NOW);
    expect(r).toEqual([]);
  });

  it("caps failure surfacing at 2 even when many fail for the same deal", () => {
    const events: RecentAuditEvent[] = Array.from({ length: 5 }, (_, i) => ({
      agent: "crier" as const,
      event: "send_failed",
      status: "confirmed_failure" as const,
      ts: `2026-05-17T${String(10 + i).padStart(2, "0")}:00:00Z`,
      recordId: "recA",
    }));
    const r = inferDealCommentary(briefing(events), "recA", listing(), NOW);
    expect(r.filter((s) => s.headline.includes("send_failed"))).toHaveLength(2);
  });
});

describe("inferDealCommentary — recent activity attestation", () => {
  it("returns a tier 1 attestation when only success events exist for this deal", () => {
    const events: RecentAuditEvent[] = [
      { agent: "sentry", event: "gate_passed", status: "confirmed_success", ts: "2026-05-17T08:00:00Z", recordId: "recA" },
    ];
    const r = inferDealCommentary(briefing(events), "recA", listing(), NOW);
    expect(r).toHaveLength(1);
    expect(r[0].tier).toBe(1);
    expect(r[0].headline).toContain("sentry");
  });

  it("does NOT add recent-activity attestation when failures already exist", () => {
    const events: RecentAuditEvent[] = [
      { agent: "crier", event: "send_failed", status: "confirmed_failure", ts: "2026-05-17T10:00:00Z", recordId: "recA" },
      { agent: "sentry", event: "gate_passed", status: "confirmed_success", ts: "2026-05-17T08:00:00Z", recordId: "recA" },
    ];
    const r = inferDealCommentary(briefing(events), "recA", listing(), NOW);
    expect(r.find((s) => s.id === "recent_activity")).toBeUndefined();
  });
});

describe("inferDealCommentary — empty state", () => {
  it("returns [] when no rules fire (watching state)", () => {
    const r = inferDealCommentary(briefing([]), "recA", listing(), NOW);
    expect(r).toEqual([]);
  });

  it("returns [] when briefing is null (pre-fetch)", () => {
    const r = inferDealCommentary(null, "recA", listing(), NOW);
    expect(r).toEqual([]);
  });
});

describe("inferDealCommentary — ordering", () => {
  it("sorts signals highest tier first", () => {
    const events: RecentAuditEvent[] = [
      { agent: "crier", event: "send_failed", status: "confirmed_failure", ts: "2026-05-17T10:00:00Z", recordId: "recA" },
    ];
    const r = inferDealCommentary(
      briefing(events),
      "recA",
      listing({
        outreachStatus: "Negotiating",
        lastInboundAt: "2026-05-10T12:00:00Z", // 7 days → tier 1
      }),
      NOW,
    );
    expect(r[0].tier).toBeGreaterThanOrEqual(r[r.length - 1].tier);
    expect(r[0].tier).toBe(2);
  });
});
