// @agent: maverick — deal-commentary inference tests.

import { describe, it, expect } from "vitest";
import {
  inferDealCommentary,
  filterEventsForDeal,
  latestContactIso,
  isUnderContract,
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
    lastEmailOutreachDate: null,
    envelopeId: null,
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

describe("latestContactIso (Phase 11.2 staleness max)", () => {
  it("returns lastOutreachDate when SMS is the only history", () => {
    expect(
      latestContactIso(listing({ lastOutreachDate: "2026-05-10T00:00:00Z" })),
    ).toBe("2026-05-10T00:00:00Z");
  });

  it("returns lastEmailOutreachDate when email is the only history", () => {
    expect(
      latestContactIso(
        listing({ lastEmailOutreachDate: "2026-05-15T18:00:00Z" }),
      ),
    ).toBe("2026-05-15T18:00:00Z");
  });

  it("returns SMS date when SMS is more recent than email", () => {
    expect(
      latestContactIso(
        listing({
          lastOutreachDate: "2026-05-17T12:00:00Z",
          lastEmailOutreachDate: "2026-05-10T00:00:00Z",
        }),
      ),
    ).toBe("2026-05-17T12:00:00Z");
  });

  it("returns email date when email is more recent than SMS (23 Fields case)", () => {
    // Pre-fix: fallback chain `lastInboundAt ?? lastOutboundAt ?? lastOutreachDate`
    // would pick lastOutreachDate even though email is more recent.
    // Post-fix: max() across all four returns the email date correctly.
    expect(
      latestContactIso(
        listing({
          lastOutreachDate: "2026-05-04T00:00:00Z", // SMS sent 14d ago
          lastEmailOutreachDate: "2026-05-17T15:30:00Z", // email sent today
        }),
      ),
    ).toBe("2026-05-17T15:30:00Z");
  });

  it("returns inbound timestamp when it's the most recent contact", () => {
    expect(
      latestContactIso(
        listing({
          lastOutreachDate: "2026-05-04T00:00:00Z",
          lastEmailOutreachDate: "2026-05-10T00:00:00Z",
          lastInboundAt: "2026-05-17T08:00:00Z",
        }),
      ),
    ).toBe("2026-05-17T08:00:00Z");
  });

  it("returns null when none of the four fields are populated", () => {
    expect(latestContactIso(listing())).toBeNull();
  });

  it("ignores unparseable timestamps and uses the next-most-recent valid one", () => {
    expect(
      latestContactIso(
        listing({
          lastEmailOutreachDate: "not-a-date",
          lastOutreachDate: "2026-05-10T00:00:00Z",
        }),
      ),
    ).toBe("2026-05-10T00:00:00Z");
  });
});

describe("inferDealCommentary — 23 Fields email-newer scenario (Phase 11.2)", () => {
  it("does NOT surface stale-followup priority when only SMS_date is old but email is recent", () => {
    // The exact failure mode from last week's 23 Fields negotiation:
    // SMS sent 20 days ago (Last_Outreach_Date), email reply exchange
    // happening today (Last_Email_Outreach_Date). Pre-fix this surfaced
    // as tier-2 "20 days without contact"; post-fix returns nothing.
    const r = inferDealCommentary(
      null,
      "recA",
      listing({
        outreachStatus: "Negotiating",
        lastOutreachDate: "2026-04-28T00:00:00Z",       // 20d ago
        lastEmailOutreachDate: "2026-05-17T15:30:00Z", // today
      }),
      new Date("2026-05-18T12:00:00Z"),
    );
    expect(r).toEqual([]);
  });

  it("still surfaces stale-followup when BOTH SMS and email are old", () => {
    const r = inferDealCommentary(
      null,
      "recA",
      listing({
        outreachStatus: "Negotiating",
        lastOutreachDate: "2026-04-28T00:00:00Z",       // 20d ago
        lastEmailOutreachDate: "2026-04-30T00:00:00Z", // 18d ago
      }),
      new Date("2026-05-18T12:00:00Z"),
    );
    expect(r).toHaveLength(1);
    expect(r[0].tier).toBe(2);
  });
});

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

describe("isUnderContract — Phase 11.4 INV-004 guard", () => {
  it("returns true when envelopeId is a non-empty string", () => {
    expect(isUnderContract({ envelopeId: "abc-123-guid" })).toBe(true);
  });

  it("returns false when envelopeId is null", () => {
    expect(isUnderContract({ envelopeId: null })).toBe(false);
  });

  it("returns false when envelopeId is an empty string", () => {
    expect(isUnderContract({ envelopeId: "" })).toBe(false);
  });
});

describe("inferDealCommentary — Phase 11.4 INV-004 contract-state guard", () => {
  it("suppresses tier-2 silence when contract is in flight (envelopeId set, Negotiating + 14d silent)", () => {
    const r = inferDealCommentary(
      briefing([]),
      "recA",
      listing({
        outreachStatus: "Negotiating",
        lastOutreachDate: "2026-05-01T12:00:00Z", // 16 days ago → would be tier 2
        envelopeId: "envelope-guid-xyz",
      }),
      NOW,
    );
    expect(r.find((s) => s.id === "crier_silence_t2")).toBeUndefined();
    expect(r.find((s) => s.id === "crier_silence_t1")).toBeUndefined();
  });

  it("still fires tier-2 silence when no contract state and 14d silent (regression test)", () => {
    const r = inferDealCommentary(
      briefing([]),
      "recA",
      listing({
        outreachStatus: "Negotiating",
        lastOutreachDate: "2026-05-01T12:00:00Z", // 16 days ago → tier 2
        envelopeId: null,
      }),
      NOW,
    );
    expect(r.find((s) => s.id === "crier_silence_t2")).toBeDefined();
  });

  it("suppresses silence signal for Response Received under contract (envelopeId set, 14d silent)", () => {
    const r = inferDealCommentary(
      briefing([]),
      "recA",
      listing({
        outreachStatus: "Response Received",
        lastInboundAt: "2026-05-01T12:00:00Z", // 16 days ago → would be tier 2
        envelopeId: "envelope-guid-abc",
      }),
      NOW,
    );
    expect(r.find((s) => s.id === "crier_silence_t2")).toBeUndefined();
    expect(r.find((s) => s.id === "crier_silence_t1")).toBeUndefined();
  });

  it("never fires silence under contract regardless of contact recency (Hallbrook-shape)", () => {
    // Recent contact + envelope set: no silence, no false-positive
    const r = inferDealCommentary(
      briefing([]),
      "recA",
      listing({
        outreachStatus: "Negotiating",
        lastOutreachDate: "2026-05-15T12:00:00Z", // 2 days ago → wouldn't fire anyway
        envelopeId: "envelope-guid-hallbrook",
      }),
      NOW,
    );
    expect(r.find((s) => s.id === "crier_silence_t2")).toBeUndefined();
    expect(r.find((s) => s.id === "crier_silence_t1")).toBeUndefined();
  });
});
