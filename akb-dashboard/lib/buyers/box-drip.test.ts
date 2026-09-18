// @agent: scout — buy-box drip tests (operator ruling 2026-09-18, Spine
// recnmCDflZ43MEsDp).

import { describe, it, expect } from "vitest";
import { selectDripCandidates, composeDripEmail, dripIntakeUrl, DRIP_STEPS, DRIP_GAP_DAYS } from "./box-drip";
import { findBannedCopy } from "@/lib/dispo/copy-guard";
import type { BuyerRecord } from "@/types/jarvis";

const NOW = "2026-09-18T12:00:00Z";

function buyer(over: Partial<BuyerRecord> = {}): BuyerRecord {
  return {
    id: "recBUYER000000001",
    name: "Test Buyer",
    entity: null, email: "buyer@example.com", phonePrimary: null, phoneSecondary: null,
    buyerType: null,
    propertyTypePreference: null, markets: ["Detroit"], targetZips: null,
    minPrice: null, maxPrice: null, minBeds: null,
    lastPurchaseDate: null, lastPurchasePrice: null, lastPurchaseAddress: null,
    linkedDealCount: null, buyerVolumeTier: null, source: null, status: "Cold",
    warmthScore: null, emailSentAt: null, emailOpenedAt: null,
    formCompletedAt: null, lastEngagementAt: null, notes: null,
    minDealSpread: null, minAssignmentFeeTarget: null, maxRehab: null, preferredCondition: null,
    pofOnFile: false, pofExpiryDate: null,
    preferredStates: null, strategyType: null,
    dispoBlastThreadId: null, dispoBlastListingId: null,
    lastResponseAt: null, buyerNotes: null,
    boxDripStep: null, boxDripLastAt: null, boxDripThreadId: null,
    ...over,
  };
}

describe("selectDripCandidates — eligibility", () => {
  it("excludes a buyer with no email", () => {
    const r = selectDripCandidates([buyer({ email: null })], NOW, 20);
    expect(r).toHaveLength(0);
  });

  it("excludes a buyer whose email has no @", () => {
    const r = selectDripCandidates([buyer({ email: "not-an-email" })], NOW, 20);
    expect(r).toHaveLength(0);
  });

  it("excludes a buyer who already has a price box", () => {
    const r = selectDripCandidates([buyer({ maxPrice: 150_000 })], NOW, 20);
    expect(r).toHaveLength(0);
  });

  it("includes a buyer whose maxPrice is 0 (no box)", () => {
    const r = selectDripCandidates([buyer({ maxPrice: 0 })], NOW, 20);
    expect(r).toHaveLength(1);
  });

  it("excludes a buyer who already completed the intake form", () => {
    const r = selectDripCandidates([buyer({ formCompletedAt: "2026-09-01T00:00:00Z" })], NOW, 20);
    expect(r).toHaveLength(0);
  });

  it.each(["Opted_Out", "opted_out", "Do Not Contact", "DO NOT CONTACT", "Inactive", "inactive"])(
    "excludes status %s",
    (status) => {
      // Status is free text on the physical table despite the narrower
      // BuyerStatus type the mapper casts through — see box-drip.ts.
      const r = selectDripCandidates([buyer({ status: status as BuyerRecord["status"] })], NOW, 20);
      expect(r).toHaveLength(0);
    },
  );

  it("excludes a buyer who has already finished all 3 steps", () => {
    const r = selectDripCandidates(
      [buyer({ boxDripStep: 3, boxDripLastAt: "2026-01-01T00:00:00Z" })],
      NOW,
      20,
    );
    expect(r).toHaveLength(0);
  });

  it("includes a never-dripped, otherwise-eligible buyer at step 1", () => {
    const r = selectDripCandidates([buyer()], NOW, 20);
    expect(r).toHaveLength(1);
    expect(r[0].step).toBe(1);
  });
});

describe("selectDripCandidates — gap timing", () => {
  it("holds step 2 before the 3-day gap since step 1", () => {
    const lastAt = new Date(Date.parse(NOW) - 2 * 86_400_000).toISOString();
    const r = selectDripCandidates([buyer({ boxDripStep: 1, boxDripLastAt: lastAt })], NOW, 20);
    expect(r).toHaveLength(0);
  });

  it("fires step 2 exactly at the 3-day gap", () => {
    const lastAt = new Date(Date.parse(NOW) - 3 * 86_400_000).toISOString();
    const r = selectDripCandidates([buyer({ boxDripStep: 1, boxDripLastAt: lastAt })], NOW, 20);
    expect(r).toHaveLength(1);
    expect(r[0].step).toBe(2);
  });

  it("holds step 3 before the 7-day gap since step 2", () => {
    const lastAt = new Date(Date.parse(NOW) - 6 * 86_400_000).toISOString();
    const r = selectDripCandidates([buyer({ boxDripStep: 2, boxDripLastAt: lastAt })], NOW, 20);
    expect(r).toHaveLength(0);
  });

  it("fires step 3 at/after the 7-day gap since step 2", () => {
    const lastAt = new Date(Date.parse(NOW) - 7 * 86_400_000).toISOString();
    const r = selectDripCandidates([buyer({ boxDripStep: 2, boxDripLastAt: lastAt })], NOW, 20);
    expect(r).toHaveLength(1);
    expect(r[0].step).toBe(3);
  });

  it("DRIP_STEPS and DRIP_GAP_DAYS match the documented cadence", () => {
    expect(DRIP_STEPS).toBe(3);
    expect(DRIP_GAP_DAYS).toEqual([0, 3, 7]);
  });
});

describe("selectDripCandidates — sort order and cap", () => {
  it("puts never-dripped buyers ahead of already-dripped ones", () => {
    const dripped = buyer({
      id: "recDRIPPED",
      boxDripStep: 1,
      boxDripLastAt: new Date(Date.parse(NOW) - 10 * 86_400_000).toISOString(),
    });
    const fresh = buyer({ id: "recFRESH" });
    const r = selectDripCandidates([dripped, fresh], NOW, 20);
    expect(r.map((x) => x.buyer.id)).toEqual(["recFRESH", "recDRIPPED"]);
  });

  it("orders already-dripped buyers by oldest last-drip first", () => {
    const older = buyer({
      id: "recOLDER",
      boxDripStep: 1,
      boxDripLastAt: new Date(Date.parse(NOW) - 20 * 86_400_000).toISOString(),
    });
    const newer = buyer({
      id: "recNEWER",
      boxDripStep: 1,
      boxDripLastAt: new Date(Date.parse(NOW) - 5 * 86_400_000).toISOString(),
    });
    const r = selectDripCandidates([newer, older], NOW, 20);
    expect(r.map((x) => x.buyer.id)).toEqual(["recOLDER", "recNEWER"]);
  });

  it("caps the result at max", () => {
    const buyers = Array.from({ length: 5 }, (_, i) => buyer({ id: `rec${i}` }));
    const r = selectDripCandidates(buyers, NOW, 2);
    expect(r).toHaveLength(2);
  });
});

describe("composeDripEmail", () => {
  const intakeUrl = "https://coach-pulse-ten.vercel.app/buyer-intake?b=recBUYER000000001";

  it.each([1, 2, 3] as const)("step %i passes findBannedCopy with zero hits, is ASCII, has the url and STOP line", (step) => {
    const { subject, body } = composeDripEmail({ buyerName: "Jamie Rivera", step, markets: ["Detroit", "Memphis"], intakeUrl });
    expect(findBannedCopy(subject)).toEqual([]);
    expect(findBannedCopy(body)).toEqual([]);
    const text = `${subject} ${body}`;
    expect(/^[\x00-\x7F]*$/.test(text)).toBe(true);
    expect(body).toContain(intakeUrl);
    expect(body).toContain("Reply STOP or remove and I will take you off the list.");
  });

  it("falls back to 'your markets' when markets is null", () => {
    const { body } = composeDripEmail({ buyerName: "Jamie", step: 1, markets: null, intakeUrl });
    expect(body).toMatch(/your markets/);
  });

  it("falls back to 'there' when buyerName is null", () => {
    const { body } = composeDripEmail({ buyerName: null, step: 1, markets: null, intakeUrl });
    expect(body).toMatch(/^Hi there,/);
  });

  it("step 3 tells the buyer no reply means the drip stops", () => {
    const { body } = composeDripEmail({ buyerName: "Jamie", step: 3, markets: null, intakeUrl });
    expect(body).toMatch(/no reply and i will stop here/i);
  });
});

describe("dripIntakeUrl", () => {
  it("builds /buyer-intake?b=<buyerId> off the base url", () => {
    expect(dripIntakeUrl("https://example.com", "recABC123")).toBe("https://example.com/buyer-intake?b=recABC123");
  });

  it("strips a trailing slash on the base url", () => {
    expect(dripIntakeUrl("https://example.com/", "recABC123")).toBe("https://example.com/buyer-intake?b=recABC123");
  });
});
