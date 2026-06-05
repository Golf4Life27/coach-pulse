// @agent: orchestrator — outreach economics guard tests.
import { describe, it, expect } from "vitest";
import {
  extractOfferAmountFromMessage,
  checkOfferOverList,
  checkFirstOutreachHydration,
} from "./outreach-economics";

const SAMPLE = (offer: string) =>
  `Hi Bridget, this is Alex with AKB Solutions. I am interested in your listing at 346 Modder Ave, Memphis, TN 38109. I would like to make a cash offer at $${offer} with a quick close. Is the seller open to offers in that range?`;

describe("extractOfferAmountFromMessage", () => {
  it("pulls the offer amount from the Crier-shaped 'cash offer at $N' line", () => {
    expect(extractOfferAmountFromMessage(SAMPLE("52,000"))).toBe(52_000);
    expect(extractOfferAmountFromMessage(SAMPLE("87,750"))).toBe(87_750);
  });
  it("returns null on no match / garbage", () => {
    expect(extractOfferAmountFromMessage("hi there")).toBeNull();
    expect(extractOfferAmountFromMessage("")).toBeNull();
  });
  it("ignores phone numbers and other $-less amounts", () => {
    expect(extractOfferAmountFromMessage("call 901-220-0869")).toBeNull();
  });
});

describe("checkOfferOverList — the >85%-of-list hard block", () => {
  it("BLOCKS a 65% offer when threshold is set tight (regression: bug surface)", () => {
    // 65% IS below the 85% default, so this should PASS. Pinning that.
    const r = checkOfferOverList(SAMPLE("52,000"), 80_000);
    expect(r.ok).toBe(true);
    expect(r.ratio).toBe(0.65);
  });
  it("BLOCKS the operator's worst-case: an inflated 90% offer", () => {
    const r = checkOfferOverList(SAMPLE("72,000"), 80_000);
    expect(r.ok).toBe(false);
    expect(r.ratio).toBe(0.9);
    expect(r.blockedBecause).toMatch(/too aggressive/);
  });
  it("passes at exactly 85% (inclusive threshold favors the operator)", () => {
    const r = checkOfferOverList(SAMPLE("68,000"), 80_000);
    expect(r.ok).toBe(true);
    expect(r.ratio).toBe(0.85);
  });
  it("BLOCKS at 85.1%", () => {
    const r = checkOfferOverList(SAMPLE("68,100"), 80_000);
    expect(r.ok).toBe(false);
  });
  it("passes when offer or list price can't be parsed (hydration is a separate gate)", () => {
    expect(checkOfferOverList(SAMPLE("52,000"), null).ok).toBe(true);
    expect(checkOfferOverList("no offer here", 80_000).ok).toBe(true);
  });
  it("honors a custom thresholdPct (operator override)", () => {
    expect(checkOfferOverList(SAMPLE("60,000"), 80_000, 0.7).ok).toBe(false); // 75% > 70%
    expect(checkOfferOverList(SAMPLE("60,000"), 80_000, 0.80).ok).toBe(true); // 75% ≤ 80%
  });
});

describe("checkFirstOutreachHydration — replaces the phantom preOfferScreenAt gate", () => {
  const HYDRATED = "2026-06-01T00:00:00.000Z";

  it("PASSES on a non-first outreach (gate doesn't apply)", () => {
    const r = checkFirstOutreachHydration({
      lastOutreachDate: "2026-05-30",
      arvValidatedAt: null,
      rehabEstimatedAt: null,
    });
    expect(r.ok).toBe(true);
    expect(r.isFirstOutreach).toBe(false);
  });

  it("PASSES on a first outreach when ARV + rehab are both hydrated", () => {
    const r = checkFirstOutreachHydration({
      lastOutreachDate: null,
      arvValidatedAt: HYDRATED,
      rehabEstimatedAt: HYDRATED,
    });
    expect(r.ok).toBe(true);
    expect(r.isFirstOutreach).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("BLOCKS a first outreach with missing ARV", () => {
    const r = checkFirstOutreachHydration({
      lastOutreachDate: null,
      arvValidatedAt: null,
      rehabEstimatedAt: HYDRATED,
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("arvValidatedAt");
    expect(r.blockedBecause).toMatch(/missing/);
  });

  it("BLOCKS a first outreach with missing rehab", () => {
    const r = checkFirstOutreachHydration({
      lastOutreachDate: null,
      arvValidatedAt: HYDRATED,
      rehabEstimatedAt: null,
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("rehabEstimatedAt");
  });

  it("BLOCKS a first outreach with BOTH missing — the 2026-06-05 regression: 6 fresh-intake records with no ARV/rehab still got sent", () => {
    const r = checkFirstOutreachHydration({
      lastOutreachDate: null,
      arvValidatedAt: null,
      rehabEstimatedAt: null,
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["arvValidatedAt", "rehabEstimatedAt"]);
  });
});
