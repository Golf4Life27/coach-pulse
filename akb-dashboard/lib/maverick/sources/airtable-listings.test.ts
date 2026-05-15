// @agent: maverick — airtable-listings summarizer tests.

import { describe, it, expect } from "vitest";
import { summarizeListings } from "./airtable-listings";
import type { Listing } from "@/lib/types";

const NOW = new Date("2026-05-15T18:00:00Z");

function listing(over: Partial<Listing> & { id: string }): Listing {
  return {
    address: "x",
    city: "Houston",
    zip: "77001",
    listPrice: 100000,
    mao: null,
    dom: null,
    offerTier: null,
    liveStatus: null,
    executionPath: null,
    outreachStatus: "Texted",
    lastOutreachDate: null,
    agentName: null,
    agentPhone: null,
    agentEmail: null,
    verificationUrl: null,
    notes: null,
    distressScore: null,
    distressBucket: null,
    bedrooms: null,
    bathrooms: null,
    buildingSqFt: null,
    stageCalc: null,
    approvedForOutreach: false,
    flipScore: null,
    offMarketOverride: false,
    restrictionText: null,
    ddChecklist: null,
    doNotText: false,
    state: null,
    actionHoldUntil: null,
    actionCardState: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    ...over,
  };
}

describe("airtable-listings summarizeListings", () => {
  it("counts records by outreach status verbatim", () => {
    const r = summarizeListings(
      [
        listing({ id: "a", outreachStatus: "Texted" }),
        listing({ id: "b", outreachStatus: "Texted" }),
        listing({ id: "c", outreachStatus: "Negotiating" }),
        listing({ id: "d", outreachStatus: "Dead" }),
        listing({ id: "e", outreachStatus: null }),
      ],
      NOW,
    );
    expect(r.pipeline_counts).toEqual({
      Texted: 2,
      Negotiating: 1,
      Dead: 1,
      "(unset)": 1,
    });
    expect(r.total_listings).toBe(5);
    expect(r.texted_universe_size).toBe(2);
  });

  it("includes only ACTIVE statuses in active_deals", () => {
    const r = summarizeListings(
      [
        listing({ id: "tex", outreachStatus: "Texted" }),
        listing({ id: "neg", outreachStatus: "Negotiating" }),
        listing({ id: "ctr", outreachStatus: "Counter Received" }),
        listing({ id: "rsp", outreachStatus: "Response Received" }),
        listing({ id: "acc", outreachStatus: "Offer Accepted" }),
        listing({ id: "ded", outreachStatus: "Dead" }),
      ],
      NOW,
    );
    const ids = r.active_deals.map((d) => d.id).sort();
    expect(ids).toEqual(["acc", "ctr", "neg", "rsp"]);
  });

  it("computes days_since_send from lastOutboundAt preferentially", () => {
    const r = summarizeListings(
      [
        listing({
          id: "a",
          outreachStatus: "Negotiating",
          lastOutboundAt: "2026-05-10T18:00:00Z", // 5 days ago
          lastOutreachDate: "2026-05-01",
        }),
      ],
      NOW,
    );
    expect(r.active_deals[0].days_since_send).toBe(5);
  });

  it("falls back to lastOutreachDate when lastOutboundAt is null", () => {
    const r = summarizeListings(
      [
        listing({
          id: "a",
          outreachStatus: "Negotiating",
          lastOutboundAt: null,
          lastOutreachDate: "2026-05-12",
        }),
      ],
      NOW,
    );
    expect(r.active_deals[0].days_since_send).toBe(3);
  });

  it("sorts active_deals by most-recent activity first", () => {
    const r = summarizeListings(
      [
        listing({ id: "old", outreachStatus: "Negotiating", lastOutboundAt: "2026-05-01T18:00:00Z" }),
        listing({ id: "mid", outreachStatus: "Negotiating", lastInboundAt: "2026-05-12T18:00:00Z" }),
        listing({ id: "new", outreachStatus: "Negotiating", lastInboundAt: "2026-05-14T18:00:00Z" }),
      ],
      NOW,
    );
    expect(r.active_deals.map((d) => d.id)).toEqual(["new", "mid", "old"]);
  });

  it("returns null days when no timestamp is set", () => {
    const r = summarizeListings(
      [
        listing({
          id: "a",
          outreachStatus: "Negotiating",
          lastOutboundAt: null,
          lastOutreachDate: null,
          lastInboundAt: null,
        }),
      ],
      NOW,
    );
    expect(r.active_deals[0].days_since_send).toBeNull();
    expect(r.active_deals[0].days_since_inbound).toBeNull();
  });

  it("handles empty input cleanly", () => {
    const r = summarizeListings([], NOW);
    expect(r).toEqual({
      pipeline_counts: {},
      active_deals: [],
      texted_universe_size: 0,
      total_listings: 0,
    });
  });
});
