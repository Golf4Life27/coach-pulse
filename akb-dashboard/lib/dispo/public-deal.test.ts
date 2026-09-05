// PUBLIC DEAL PAGE — projection tests (2026-09-05).
//
// The load-bearing assertion here is the JSON.stringify sweep: this is the
// ONE unauthenticated read path in the app, so the test doesn't just check
// individual fields are absent — it greps the actual serialized output for
// the words a leak would introduce (contract, arv, rehab, agent, notes,
// listPrice), so a future field added to Listing and carelessly spread into
// the view gets caught even if nobody remembers to update this test's field
// list.

import { describe, it, expect } from "vitest";
import { publicDealView } from "./public-deal";
import type { Listing } from "@/lib/types";

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: "recDEAL0000000001",
    address: "123 Example St",
    city: "Memphis",
    zip: "38116",
    listPrice: 150_000,
    mao: 90_000,
    dom: 12,
    offerTier: "A",
    liveStatus: "Active",
    executionPath: null,
    outreachStatus: "Negotiating",
    lastOutreachDate: null,
    agentName: "Jane Agent",
    agentPhone: "5551234567",
    agentEmail: "jane@brokerage.com",
    verificationUrl: null,
    notes: "Seller is desperate, do not tell buyer this.",
    distressScore: 80,
    distressBucket: "High",
    bedrooms: 3,
    bathrooms: 2,
    buildingSqFt: 1400,
    yearBuilt: 1965,
    portfolioDetected: false,
    stageCalc: null,
    approvedForOutreach: true,
    flipScore: null,
    offMarketOverride: false,
    restrictionText: null,
    ddChecklist: null,
    doNotText: false,
    state: "TN",
    sourceVersion: "v2_post_2026-05-26",
    actionHoldUntil: null,
    actionCardState: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastEmailOutreachDate: null,
    envelopeId: null,
    ...over,
  };
}

describe("publicDealView", () => {
  it("returns null when dispoPublic is not explicitly true", () => {
    expect(publicDealView(listing({ dispoPublic: undefined }))).toBeNull();
    expect(publicDealView(listing({ dispoPublic: null }))).toBeNull();
    expect(publicDealView(listing({ dispoPublic: false }))).toBeNull();
  });

  it("returns the buyer-safe view when dispoPublic is true", () => {
    const view = publicDealView(
      listing({
        dispoPublic: true,
        assignmentPrice: 175_000,
        optionDeadline: "2026-09-15",
        closeDate: "2026-10-01",
        propertyType: "Single Family",
        dealPhotoUrls: JSON.stringify(["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"]),
      }),
    );
    expect(view).not.toBeNull();
    expect(view).toEqual({
      recordId: "recDEAL0000000001",
      address: "123 Example St",
      city: "Memphis",
      state: "TN",
      zip: "38116",
      beds: 3,
      baths: 2,
      sqft: 1400,
      yearBuilt: 1965,
      propertyType: "Single Family",
      assignmentPrice: 175_000,
      optionDeadline: "2026-09-15",
      closeDate: "2026-10-01",
      photos: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
      headline: "Off-market: 123 Example St",
    });
  });

  describe("photo parsing — dealPhotoUrls degrades to [] rather than throwing", () => {
    it("parses a valid JSON array of strings", () => {
      const view = publicDealView(
        listing({ dispoPublic: true, dealPhotoUrls: JSON.stringify(["https://x/1.jpg", "https://x/2.jpg"]) }),
      );
      expect(view?.photos).toEqual(["https://x/1.jpg", "https://x/2.jpg"]);
    });

    it("returns [] for null", () => {
      const view = publicDealView(listing({ dispoPublic: true, dealPhotoUrls: null }));
      expect(view?.photos).toEqual([]);
    });

    it("returns [] for malformed JSON", () => {
      const view = publicDealView(listing({ dispoPublic: true, dealPhotoUrls: "not json{{{" }));
      expect(view?.photos).toEqual([]);
    });

    it("returns [] for valid JSON that isn't an array", () => {
      const view = publicDealView(listing({ dispoPublic: true, dealPhotoUrls: JSON.stringify({ url: "x" }) }));
      expect(view?.photos).toEqual([]);
    });

    it("drops non-string entries from a mixed array rather than failing whole", () => {
      const view = publicDealView(
        listing({ dispoPublic: true, dealPhotoUrls: JSON.stringify(["https://x/1.jpg", 42, null, ""]) }),
      );
      expect(view?.photos).toEqual(["https://x/1.jpg"]);
    });
  });

  it("never leaks listPrice, contract/offer prices, ARV, rehab, fee, spread, agent, or notes", () => {
    const view = publicDealView(
      listing({
        dispoPublic: true,
        assignmentPrice: 175_000,
        listPrice: 150_000,
        contractOfferPrice: 140_000,
        outreachOfferPrice: 130_000,
        underwrittenMao: 120_000,
        underwrittenPropertyMao: 118_000,
        realArvMedian: 220_000,
        estRehab: 40_000,
        wholesaleFeeTarget: 15_000,
        dealSpread: 30_000,
        agentName: "Jane Agent",
        agentPhone: "5551234567",
        agentEmail: "jane@brokerage.com",
        notes: "Seller is desperate, do not tell buyer this.",
      }),
    );
    const serialized = JSON.stringify(view).toLowerCase();
    for (const forbidden of ["contract", "arv", "rehab", "agent", "notes", "listprice"]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Belt-and-suspenders: the specific leaked values must not appear either.
    expect(serialized).not.toContain("jane");
    expect(serialized).not.toContain("desperate");
    expect(serialized).not.toContain("150000");
    expect(serialized).not.toContain("140000");
  });
});
