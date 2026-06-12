import { describe, it, expect } from "vitest";
import { matchPricingBuyer, buyerTracks } from "./match-pricing-buyer";
import type { BuyerRecord } from "@/types/jarvis";

const NOW = new Date("2026-06-12T12:00:00Z");

function buyer(over: Partial<BuyerRecord> = {}): BuyerRecord {
  return {
    id: "recBUYER000000001",
    name: "Test Buyer",
    entity: null, email: null, phonePrimary: null, phoneSecondary: null,
    buyerType: "flipper",
    propertyTypePreference: null, markets: null, targetZips: null,
    minPrice: null, maxPrice: null, minBeds: null,
    lastPurchaseDate: null, lastPurchasePrice: null, lastPurchaseAddress: null,
    linkedDealCount: null, buyerVolumeTier: null, source: null, status: null,
    warmthScore: null, emailSentAt: null, emailOpenedAt: null,
    formCompletedAt: null, lastEngagementAt: null, notes: null,
    minDealSpread: 40_000,
    minAssignmentFeeTarget: null, maxRehab: null, preferredCondition: null,
    pofOnFile: true, pofExpiryDate: null,
    preferredStates: "MI", strategyType: null,
    ...over,
  };
}

const LISTING = { state: "MI", track: "flipper" as const, arv: 150_000 };

describe("matchPricingBuyer — exactly one or HOLD", () => {
  it("single qualified buyer matches with their purchase price", () => {
    const r = matchPricingBuyer(LISTING, [buyer()], NOW);
    expect(r.matched).toBe(true);
    if (r.matched) {
      expect(r.buyerPurchasePrice).toBe(110_000); // 150k − 40k spread
      expect(r.qualifiedCount).toBe(1);
    }
  });
  it("tiebreak: highest Min_Deal_Spread wins (most conservative)", () => {
    const loose = buyer({ id: "recLOOSE000000001", minDealSpread: 30_000 });
    const tight = buyer({ id: "recTIGHT000000001", minDealSpread: 55_000 });
    const r = matchPricingBuyer(LISTING, [loose, tight], NOW);
    expect(r.matched).toBe(true);
    if (r.matched) {
      expect(r.buyer.id).toBe("recTIGHT000000001");
      expect(r.buyerPurchasePrice).toBe(95_000);
      expect(r.qualifiedCount).toBe(2);
    }
  });
});

describe("hard filters — each excludes", () => {
  it("state mismatch", () => {
    const r = matchPricingBuyer(LISTING, [buyer({ preferredStates: "TX" })], NOW);
    expect(r.matched).toBe(false);
  });
  it("markets[] fallback satisfies state (Detroit → MI)", () => {
    const r = matchPricingBuyer(LISTING, [buyer({ preferredStates: null, markets: ["Detroit"] })], NOW);
    expect(r.matched).toBe(true);
  });
  it("track mismatch (landlord buyer for flipper-track listing)", () => {
    const r = matchPricingBuyer(LISTING, [buyer({ buyerType: "landlord", strategyType: null })], NOW);
    expect(r.matched).toBe(false);
  });
  it("Strategy_Type fallback resolves track on legacy rows (Flip → flipper)", () => {
    const r = matchPricingBuyer(LISTING, [buyer({ buyerType: null, strategyType: ["Flip"] })], NOW);
    expect(r.matched).toBe(true);
  });
  it("no POF → excluded", () => {
    const r = matchPricingBuyer(LISTING, [buyer({ pofOnFile: false })], NOW);
    expect(r.matched).toBe(false);
    if (!r.matched) expect(r.detail).toContain("pof=1");
  });
  it("expired POF → excluded", () => {
    const r = matchPricingBuyer(LISTING, [buyer({ pofExpiryDate: "2026-01-01" })], NOW);
    expect(r.matched).toBe(false);
  });
  it("null Min_Deal_Spread → excluded (the Tier-C data gap, expected day-one shape)", () => {
    const r = matchPricingBuyer(LISTING, [buyer({ minDealSpread: null })], NOW);
    expect(r.matched).toBe(false);
    if (!r.matched) {
      expect(r.reason).toBe("no_matching_buyer_for_pricing");
      expect(r.detail).toContain("null_spread=1");
    }
  });
  it("band fit uses the buyer's OWN resulting purchase price", () => {
    // purchase = 150k − 40k = 110k; buyer max 100k → out of band
    const r = matchPricingBuyer(LISTING, [buyer({ maxPrice: 100_000 })], NOW);
    expect(r.matched).toBe(false);
    // raise max → fits
    const r2 = matchPricingBuyer(LISTING, [buyer({ maxPrice: 120_000 })], NOW);
    expect(r2.matched).toBe(true);
  });
});

describe("HOLD shapes", () => {
  it("null ARV → HOLD before any buyer evaluation", () => {
    const r = matchPricingBuyer({ ...LISTING, arv: null }, [buyer()], NOW);
    expect(r.matched).toBe(false);
    if (!r.matched) expect(r.detail).toContain("ARV missing");
  });
  it("empty pool → HOLD with the exclusion histogram", () => {
    const r = matchPricingBuyer(LISTING, [], NOW);
    expect(r.matched).toBe(false);
  });
});

describe("buyerTracks", () => {
  it("dual-strategy buyer matches both tracks", () => {
    const t = buyerTracks(buyer({ buyerType: null, strategyType: ["Flip", "Buy-and-Hold"] }));
    expect(t.has("flipper")).toBe(true);
    expect(t.has("landlord")).toBe(true);
  });
});
