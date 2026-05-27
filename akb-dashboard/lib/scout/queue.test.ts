// Phase 4.5 + 4.6 / Q.5 — Scout queue tests.

import { describe, it, expect } from "vitest";
import {
  buildDispoQueue,
  classifyDispoReadiness,
  selectScoutPrioritySignals,
} from "./queue";
import type { Listing } from "@/lib/types";

function mkListing(over: Partial<Listing> = {}): Listing {
  return {
    id: "recX",
    address: "100 Test Ave",
    city: "SA",
    zip: "78210",
    listPrice: 150_000,
    mao: null,
    dom: null,
    offerTier: null,
    liveStatus: null,
    executionPath: null,
    outreachStatus: "Offer Accepted",
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
    state: "TX",
    sourceVersion: null,
    actionHoldUntil: null,
    actionCardState: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastEmailOutreachDate: null,
    envelopeId: null,
    ...over,
  };
}

describe("classifyDispoReadiness", () => {
  it("returns null when not in dispo-ready outreach status", () => {
    expect(classifyDispoReadiness(mkListing({ outreachStatus: "Texted" }))).toBeNull();
    expect(classifyDispoReadiness(mkListing({ outreachStatus: "Dead" }))).toBeNull();
    expect(classifyDispoReadiness(mkListing({ outreachStatus: null }))).toBeNull();
  });

  it("returns signal when status matches and basic pricing present", () => {
    const r = classifyDispoReadiness(mkListing());
    expect(r).not.toBeNull();
    expect(r?.recordId).toBe("recX");
    expect(r?.readiness_score).toBeGreaterThan(0);
  });

  it("higher readiness when ARV + rent + contract offer are populated", () => {
    const bare = classifyDispoReadiness(mkListing());
    const enriched = classifyDispoReadiness(
      mkListing({
        contractOfferPrice: 95_000,
        realArvMedian: 165_000,
        estimatedMonthlyRent: 1400,
      }),
    );
    expect(enriched!.readiness_score).toBeGreaterThan(bare!.readiness_score);
    expect(enriched!.signals.length).toBeGreaterThan(bare!.signals.length);
  });

  it("warns when no ARV", () => {
    const r = classifyDispoReadiness(mkListing({ realArvMedian: null }));
    expect(r!.warnings).toContain("No ARV — run Appraiser before dispo");
  });

  it("warns when no contract offer", () => {
    const r = classifyDispoReadiness(mkListing({ contractOfferPrice: null }));
    expect(r!.warnings).toContain("No contract offer price set");
  });

  it("penalizes LOW arvConfidence", () => {
    const med = classifyDispoReadiness(
      mkListing({ realArvMedian: 165_000, arvConfidence: "MED" }),
    );
    const low = classifyDispoReadiness(
      mkListing({ realArvMedian: 165_000, arvConfidence: "LOW" }),
    );
    expect(low!.readiness_score).toBeLessThan(med!.readiness_score);
    expect(low!.warnings.some((w) => w.includes("LOW"))).toBe(true);
  });

  it("readiness_score clamped to [0, 100]", () => {
    const r = classifyDispoReadiness(
      mkListing({
        contractOfferPrice: 95_000,
        realArvMedian: 165_000,
        estimatedMonthlyRent: 1400,
      }),
    );
    expect(r!.readiness_score).toBeLessThanOrEqual(100);
    expect(r!.readiness_score).toBeGreaterThanOrEqual(0);
  });
});

describe("buildDispoQueue", () => {
  it("sorts by readiness_score desc", () => {
    const queue = buildDispoQueue([
      mkListing({ id: "low" }),
      mkListing({
        id: "high",
        contractOfferPrice: 95_000,
        realArvMedian: 165_000,
        estimatedMonthlyRent: 1400,
      }),
      mkListing({ id: "skip", outreachStatus: "Texted" }),
    ]);
    expect(queue.length).toBe(2);
    expect(queue[0].recordId).toBe("high");
    expect(queue[1].recordId).toBe("low");
  });
});

describe("selectScoutPrioritySignals", () => {
  it("filters to high-score and tops out at N", () => {
    const result = selectScoutPrioritySignals(
      Array.from({ length: 10 }, (_, i) =>
        mkListing({
          id: `r${i}`,
          contractOfferPrice: 95_000,
          realArvMedian: 165_000,
          estimatedMonthlyRent: 1400,
        }),
      ),
      { topN: 3 },
    );
    expect(result.length).toBe(3);
    expect(result.every((s) => s.readiness_score >= 60)).toBe(true);
  });

  it("drops scores below min", () => {
    const result = selectScoutPrioritySignals(
      [mkListing({ contractOfferPrice: null, realArvMedian: null })],
      { min_score: 80 },
    );
    expect(result).toEqual([]);
  });
});
