import { describe, it, expect } from "vitest";
import { detectUnbackedReplyStatus } from "./unbacked-reply-status";
import type { PulseDetectorInput } from "../detector-input";
import type { Listing } from "@/lib/types";

const NOW = new Date("2026-06-08T12:00:00Z");

function listing(over: Partial<Listing>): Listing {
  return {
    id: "rec1",
    address: "100 Main St",
    city: "Memphis",
    state: "TN",
    zip: "38109",
    listPrice: 80000,
    mao: null,
    dom: null,
    offerTier: null,
    liveStatus: "Active",
    executionPath: "Auto Proceed",
    agentName: "agent",
    agentPhone: "9011111111",
    agentEmail: null,
    verificationUrl: null,
    notes: null,
    distressScore: null,
    distressBucket: null,
    bedrooms: null,
    bathrooms: null,
    buildingSqFt: null,
    yearBuilt: null,
    stageCalc: null,
    approvedForOutreach: true,
    flipScore: null,
    offMarketOverride: false,
    restrictionText: null,
    ddChecklist: null,
    doNotText: false,
    outreachStatus: "Response Received",
    lastInboundAt: null,
    lastOutboundAt: null,
    sourceVersion: "v2_post_2026-05-26",
    ...over,
  } as Listing;
}

function input(listings: Listing[], env: Record<string, string | undefined> = {}): PulseDetectorInput {
  return {
    audit_log: [],
    listings,
    test_count: null,
    previous_test_count: null,
    env,
    now: () => NOW,
  };
}

describe("detectUnbackedReplyStatus — the 5/1 shape detector", () => {
  it("silent when no records assert a reply without inbound", () => {
    expect(detectUnbackedReplyStatus(input([]))).toEqual([]);
    expect(detectUnbackedReplyStatus(input([listing({ outreachStatus: "Texted" })]))).toEqual([]);
  });

  it("silent on a few records (below warning floor — normal noise)", () => {
    const ls = Array.from({ length: 3 }, (_, i) => listing({ id: `rec${i}` }));
    expect(detectUnbackedReplyStatus(input(ls))).toEqual([]);
  });

  it("does NOT fire when the inbound timestamp is present (the supported case)", () => {
    const ls = Array.from({ length: 20 }, (_, i) =>
      listing({ id: `rec${i}`, lastInboundAt: "2026-06-07T12:00:00Z" }),
    );
    expect(detectUnbackedReplyStatus(input(ls))).toEqual([]);
  });

  it("fires WARNING at >= 5 unbacked records (the warning floor)", () => {
    const ls = Array.from({ length: 5 }, (_, i) => listing({ id: `rec${i}` }));
    const r = detectUnbackedReplyStatus(input(ls));
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("warning");
    expect(r[0].title).toContain("5 active records");
  });

  it("escalates to CRITICAL at >= 12 (the 5/1 16-record bulk would trip this)", () => {
    const ls = Array.from({ length: 16 }, (_, i) =>
      listing({ id: `rec${i}`, state: i < 16 ? "MI" : "TX" }),
    );
    const r = detectUnbackedReplyStatus(input(ls));
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("critical");
  });

  it("buckets by state in source_data so the operator sees where the burst is", () => {
    const ls = [
      ...Array.from({ length: 11 }, (_, i) => listing({ id: `mi${i}`, state: "MI" })),
      ...Array.from({ length: 3 }, (_, i) => listing({ id: `tx${i}`, state: "TX" })),
    ];
    const r = detectUnbackedReplyStatus(input(ls));
    expect(r[0].source_data?.by_state).toEqual({ MI: 11, TX: 3 });
  });

  it("catches all four reply-implying statuses, not just Response Received", () => {
    const ls = [
      listing({ id: "a", outreachStatus: "Response Received" }),
      listing({ id: "b", outreachStatus: "Counter Received" }),
      listing({ id: "c", outreachStatus: "Negotiating" }),
      listing({ id: "d", outreachStatus: "Offer Accepted" }),
      listing({ id: "e", outreachStatus: "Response Received" }),
    ];
    const r = detectUnbackedReplyStatus(input(ls));
    expect(r).toHaveLength(1);
    expect(r[0].source_data?.offending_count).toBe(5);
  });

  it("respects env overrides on both thresholds", () => {
    const ls = Array.from({ length: 6 }, (_, i) => listing({ id: `rec${i}` }));
    expect(
      detectUnbackedReplyStatus(input(ls, { PULSE_UNBACKED_STATUS_WARNING: "10" })),
    ).toEqual([]);
    const critical = detectUnbackedReplyStatus(
      input(ls, { PULSE_UNBACKED_STATUS_CRITICAL: "5" }),
    );
    expect(critical[0].severity).toBe("critical");
  });

  it("sample is bounded at 8 records (audit-row size guard)", () => {
    const ls = Array.from({ length: 20 }, (_, i) => listing({ id: `rec${i}` }));
    const r = detectUnbackedReplyStatus(input(ls));
    const sample = r[0].source_data?.sample as unknown[];
    expect(sample.length).toBe(8);
  });
});
