import { describe, it, expect } from "vitest";
import { priceDropFastlaneVerdict, rankFastlaneTargets } from "./price-drop-fastlane";
import { SOURCE_VERSION_V2 } from "./source-version";
import type { Listing } from "./types";

const NOW = new Date("2026-07-11T16:00:00Z");

function cutRecord(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "recCUT0000000001",
    address: "817 Regal Ln SW, Atlanta, GA 30331",
    city: "Atlanta",
    zip: "30331",
    listPrice: 299_000, // cut below the $319k renovated value
    prevListPrice: 355_000,
    priceDropCount: 1,
    mao: null,
    dom: null,
    offerTier: null,
    liveStatus: "Active",
    executionPath: "Auto Proceed",
    outreachStatus: "",
    lastOutreachDate: null,
    agentName: "Lisa",
    agentPhone: "+14045550100",
    agentEmail: null,
    verificationUrl: "https://example.com/x",
    notes: null,
    distressScore: null,
    distressBucket: null,
    bedrooms: 3,
    bathrooms: 2,
    buildingSqFt: 1877,
    yearBuilt: 1970,
    portfolioDetected: false,
    stageCalc: null,
    approvedForOutreach: true,
    flipScore: null,
    offMarketOverride: false,
    restrictionText: null,
    ddChecklist: null,
    doNotText: false,
    state: "GA",
    sourceVersion: SOURCE_VERSION_V2,
    actionHoldUntil: null,
    actionCardState: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastEmailOutreachDate: null,
    envelopeId: null,
    lastVerified: "2026-07-05T10:00:00Z", // stale — needs the fast lane
    ...overrides,
  };
}

const SEED_ARV = 319_090;

describe("priceDropFastlaneVerdict", () => {
  it("a stale record with a real cut below renovated value is DUE, ranked by spread", () => {
    const v = priceDropFastlaneVerdict(cutRecord(), SEED_ARV, NOW);
    expect(v.due).toBe(true);
    expect(v.spread).toBe(20_090);
  });

  it("no cut evidence → not due (the lane is for CUTS, not general staleness)", () => {
    const v = priceDropFastlaneVerdict(
      cutRecord({ priceDropCount: 0, prevListPrice: null }),
      SEED_ARV,
      NOW,
    );
    expect(v.reason).toBe("no_price_cut_evidence");
  });

  it("still over renovated value → not due (cash still can't pencil)", () => {
    const v = priceDropFastlaneVerdict(cutRecord({ listPrice: 340_000 }), SEED_ARV, NOW);
    expect(v.reason).toBe("still_over_renovated_value");
  });

  it("no seed basis → not due (never guess a value)", () => {
    expect(priceDropFastlaneVerdict(cutRecord(), null, NOW).reason).toBe("no_value_basis");
  });

  it("already fresh → not due (no credit spent; the send slot sees it)", () => {
    const v = priceDropFastlaneVerdict(cutRecord({ lastVerified: "2026-07-11T10:00:00Z" }), SEED_ARV, NOW);
    expect(v.reason).toBe("already_fresh");
  });

  it("pool/era/liveness/market gates hold", () => {
    expect(priceDropFastlaneVerdict(cutRecord({ outreachStatus: "Texted" }), SEED_ARV, NOW).reason).toBe("not_first_touch_pool");
    expect(priceDropFastlaneVerdict(cutRecord({ sourceVersion: "v1_legacy" }), SEED_ARV, NOW).reason).toBe("not_v2");
    expect(priceDropFastlaneVerdict(cutRecord({ liveStatus: "" }), SEED_ARV, NOW).reason).toBe("not_active");
    expect(priceDropFastlaneVerdict(cutRecord({ state: "MO" }), SEED_ARV, NOW).due).toBe(false);
  });
});

describe("rankFastlaneTargets", () => {
  it("deepest newly-penciling cut first", () => {
    const ranked = rankFastlaneTargets([{ spread: 5_000 }, { spread: 42_000 }, { spread: null }]);
    expect(ranked.map((t) => t.spread)).toEqual([42_000, 5_000, null]);
  });
});
