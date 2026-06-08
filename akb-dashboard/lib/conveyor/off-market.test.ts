import { describe, expect, it } from "vitest";
import { hasDeliveredOfferFor, hasOpenThreadFrom } from "./off-market";

describe("hasDeliveredOfferFor", () => {
  it("returns false for empty / null / not-yet-outreached statuses", () => {
    expect(hasDeliveredOfferFor(null)).toBe(false);
    expect(hasDeliveredOfferFor(undefined)).toBe(false);
    expect(hasDeliveredOfferFor("")).toBe(false);
    expect(hasDeliveredOfferFor("Review")).toBe(false);
    expect(hasDeliveredOfferFor("Manual Review")).toBe(false);
    expect(hasDeliveredOfferFor("Dead")).toBe(false);
  });

  it("returns true for the outreach-fired statuses", () => {
    expect(hasDeliveredOfferFor("Texted")).toBe(true);
    expect(hasDeliveredOfferFor("Texted (Portfolio)")).toBe(true);
    expect(hasDeliveredOfferFor("Emailed")).toBe(true);
    expect(hasDeliveredOfferFor("Response Received")).toBe(true);
    expect(hasDeliveredOfferFor("Negotiating")).toBe(true);
    expect(hasDeliveredOfferFor("Counter Received")).toBe(true);
    expect(hasDeliveredOfferFor("Offer Accepted")).toBe(true);
    expect(hasDeliveredOfferFor("Contract Signed")).toBe(true);
  });

  it("returns false for unknown statuses (defensive — never assume)", () => {
    expect(hasDeliveredOfferFor("Pending")).toBe(false);
    expect(hasDeliveredOfferFor("Some New State")).toBe(false);
  });
});

describe("hasOpenThreadFrom", () => {
  const NOW = new Date("2026-06-08T18:00:00Z");

  it("returns false when both timestamps are null", () => {
    expect(hasOpenThreadFrom(null, null, NOW)).toBe(false);
    expect(hasOpenThreadFrom(undefined, undefined, NOW)).toBe(false);
  });

  it("returns true when last inbound is within the 30-day window", () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 3_600_000).toISOString();
    expect(hasOpenThreadFrom(tenDaysAgo, null, NOW)).toBe(true);
  });

  it("returns true when last outbound is within the 30-day window", () => {
    const fiveDaysAgo = new Date(NOW.getTime() - 5 * 24 * 3_600_000).toISOString();
    expect(hasOpenThreadFrom(null, fiveDaysAgo, NOW)).toBe(true);
  });

  it("returns false when both timestamps are older than 30 days", () => {
    const oldDate = new Date(NOW.getTime() - 60 * 24 * 3_600_000).toISOString();
    expect(hasOpenThreadFrom(oldDate, oldDate, NOW)).toBe(false);
  });

  it("treats exactly the cutoff as open (inclusive)", () => {
    const exactCutoff = new Date(NOW.getTime() - 30 * 24 * 3_600_000).toISOString();
    expect(hasOpenThreadFrom(exactCutoff, null, NOW)).toBe(true);
  });

  it("ignores unparseable timestamps", () => {
    expect(hasOpenThreadFrom("not-a-date", "also-bad", NOW)).toBe(false);
  });

  it("respects a custom window", () => {
    const fourDaysAgo = new Date(NOW.getTime() - 4 * 24 * 3_600_000).toISOString();
    const threeDays = 3 * 24 * 3_600_000;
    expect(hasOpenThreadFrom(fourDaysAgo, null, NOW, threeDays)).toBe(false);
  });
});
