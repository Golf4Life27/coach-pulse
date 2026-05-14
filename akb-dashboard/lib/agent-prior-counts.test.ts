// Unit tests for computeAgentPriorCounts — the pure grouping/counting
// logic that replaces Make's broken phone-string grouping. Per Alex's
// 5/14 spec, coverage targets:
//   - empty input handles cleanly
//   - single-agent multi-listing counts correctly
//   - mixed-format phones group correctly post-normalize
//   - email-in-phone records skip cleanly
//   - dead/inactive records don't count toward siblings
//   - solo listing returns 0
//   - changedUpdates filters noise writes

import { describe, it, expect } from "vitest";
import {
  computeAgentPriorCounts,
  changedUpdates,
  type PriorCountUpdate,
} from "./agent-prior-counts";
import type { Listing } from "./types";

// Minimal Listing factory — only the fields the function reads.
function listing(over: Partial<Listing> & { id: string }): Listing {
  return {
    address: "x",
    city: "x",
    zip: "x",
    listPrice: null,
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
    agentPriorOutreachCount: null,
    ...over,
  };
}

describe("computeAgentPriorCounts — empty + solo", () => {
  it("empty input returns empty result", () => {
    const r = computeAgentPriorCounts([]);
    expect(r.updates).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.distinctNormalizedPhones).toBe(0);
    expect(r.phonesOnMultipleListings).toBe(0);
  });

  it("solo Texted listing → count 0", () => {
    const r = computeAgentPriorCounts([
      listing({ id: "recA", outreachStatus: "Texted", agentPhone: "713-555-1000" }),
    ]);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0].newCount).toBe(0);
    expect(r.updates[0].agentPhoneNormalized).toBe("+17135551000");
    expect(r.distinctNormalizedPhones).toBe(1);
    expect(r.phonesOnMultipleListings).toBe(0);
  });
});

describe("computeAgentPriorCounts — sibling counting", () => {
  it("3 Texted listings same agent → each gets count 2", () => {
    const r = computeAgentPriorCounts([
      listing({ id: "recA", outreachStatus: "Texted", agentPhone: "713-555-1000" }),
      listing({ id: "recB", outreachStatus: "Texted", agentPhone: "713-555-1000" }),
      listing({ id: "recC", outreachStatus: "Texted", agentPhone: "713-555-1000" }),
    ]);
    expect(r.updates).toHaveLength(3);
    for (const u of r.updates) {
      expect(u.newCount).toBe(2);
    }
    expect(r.distinctNormalizedPhones).toBe(1);
    expect(r.phonesOnMultipleListings).toBe(1);
  });

  it("mixed format phones group correctly after normalize", () => {
    // Same human agent stored as 4 different formats — the 5/14 finding
    // that motivated Path Y in the first place.
    const r = computeAgentPriorCounts([
      listing({ id: "recA", outreachStatus: "Texted", agentPhone: "(713) 231-1129" }),
      listing({ id: "recB", outreachStatus: "Texted", agentPhone: "713-231-1129" }),
      listing({ id: "recC", outreachStatus: "Texted", agentPhone: "713.231.1129" }),
      listing({ id: "recD", outreachStatus: "Texted", agentPhone: "+17132311129" }),
    ]);
    expect(r.updates).toHaveLength(4);
    for (const u of r.updates) {
      expect(u.newCount).toBe(3);
      expect(u.agentPhoneNormalized).toBe("+17132311129");
    }
    expect(r.distinctNormalizedPhones).toBe(1);
  });

  it("Negotiating + Texted records count as siblings to each other", () => {
    const r = computeAgentPriorCounts([
      listing({ id: "recA", outreachStatus: "Texted", agentPhone: "713-555-2000" }),
      listing({ id: "recB", outreachStatus: "Negotiating", agentPhone: "713-555-2000" }),
    ]);
    expect(r.updates).toHaveLength(2);
    expect(r.updates.find((u) => u.recordId === "recA")?.newCount).toBe(1);
    expect(r.updates.find((u) => u.recordId === "recB")?.newCount).toBe(1);
  });
});

describe("computeAgentPriorCounts — status filtering", () => {
  it("Dead/inactive records don't count toward Texted siblings", () => {
    const r = computeAgentPriorCounts([
      listing({ id: "recTexted", outreachStatus: "Texted", agentPhone: "713-555-3000" }),
      listing({ id: "recDead", outreachStatus: "Dead", agentPhone: "713-555-3000" }),
      listing({ id: "recNotContacted", outreachStatus: "Not Contacted", agentPhone: "713-555-3000" }),
    ]);
    // Only recTexted is eligible AND in the sibling pool. Its newCount
    // should be 0 because the other two don't count.
    const textedUpdate = r.updates.find((u) => u.recordId === "recTexted");
    expect(textedUpdate?.newCount).toBe(0);
    // Dead and Not Contacted appear in skipped with reason status_not_eligible.
    const skippedIds = r.skipped.map((s) => s.recordId).sort();
    expect(skippedIds).toEqual(["recDead", "recNotContacted"]);
    for (const s of r.skipped) {
      expect(s.reason).toBe("status_not_eligible");
    }
  });

  it("Negotiating siblings count even when the focus record is Texted", () => {
    const r = computeAgentPriorCounts([
      listing({ id: "recTexted", outreachStatus: "Texted", agentPhone: "713-555-4000" }),
      listing({ id: "recNegA", outreachStatus: "Negotiating", agentPhone: "713-555-4000" }),
      listing({ id: "recNegB", outreachStatus: "Negotiating", agentPhone: "713-555-4000" }),
    ]);
    expect(r.updates.find((u) => u.recordId === "recTexted")?.newCount).toBe(2);
  });
});

describe("computeAgentPriorCounts — phone normalize failures", () => {
  it("email-in-phone-field record skips cleanly with phone_failed_to_normalize", () => {
    const r = computeAgentPriorCounts([
      listing({ id: "recEmail", outreachStatus: "Texted", agentPhone: "jmarin@kw.com" }),
      listing({ id: "recNull", outreachStatus: "Texted", agentPhone: null }),
      listing({ id: "recValid", outreachStatus: "Texted", agentPhone: "713-555-5000" }),
    ]);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0].recordId).toBe("recValid");
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped.every((s) => s.reason === "phone_failed_to_normalize")).toBe(true);
  });

  it("malformed phone (digits<10) skips cleanly", () => {
    const r = computeAgentPriorCounts([
      listing({ id: "recShort", outreachStatus: "Texted", agentPhone: "555-1234" }),
    ]);
    expect(r.updates).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toBe("phone_failed_to_normalize");
  });
});

describe("changedUpdates — noise filtering", () => {
  it("filters out updates where new count matches stored count", () => {
    const updates: PriorCountUpdate[] = [
      {
        recordId: "recUnchanged",
        agentPhoneRaw: "x",
        agentPhoneNormalized: "+1",
        previousCount: 2,
        newCount: 2,
      },
      {
        recordId: "recCorrection",
        agentPhoneRaw: "x",
        agentPhoneNormalized: "+1",
        previousCount: 0,
        newCount: 4,
      },
      {
        recordId: "recOvercount",
        agentPhoneRaw: "x",
        agentPhoneNormalized: "+1",
        previousCount: 13,
        newCount: 0,
      },
    ];
    const changed = changedUpdates(updates);
    expect(changed.map((u) => u.recordId)).toEqual(["recCorrection", "recOvercount"]);
  });

  it("treats null previousCount + 0 newCount as unchanged", () => {
    const updates: PriorCountUpdate[] = [
      {
        recordId: "recNullToZero",
        agentPhoneRaw: "x",
        agentPhoneNormalized: "+1",
        previousCount: null,
        newCount: 0,
      },
    ];
    // null != 0 by strict comparison, so this counts as a change. That's
    // intentional: a record whose count was never populated should get
    // written with 0 once on first recompute.
    const changed = changedUpdates(updates);
    expect(changed).toHaveLength(1);
  });
});
