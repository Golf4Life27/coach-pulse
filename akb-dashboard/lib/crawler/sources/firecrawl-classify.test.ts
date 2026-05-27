// classifyVerifiedListing decision tests (accept / review / reject ordering).

import { describe, it, expect } from "vitest";
import { classifyVerifiedListing, type FirecrawlVerifyResult } from "./firecrawl";

/** A fully-green verify result (resolved, active, clean, has condition). */
function fc(over: Partial<FirecrawlVerifyResult> = {}): FirecrawlVerifyResult {
  return {
    credentialed: true,
    resolved: true,
    url: "https://www.redfin.com/x",
    stillActive: true,
    hasRenovatedLanguage: false,
    matchedKeywords: [],
    wholesalerExcluded: false,
    matchedWholesalerKeywords: [],
    hasConditionSignal: true,
    matchedDistressKeywords: ["as-is"],
    isNewConstruction: false,
    matchedNewConstructionSignals: [],
    matchedInactiveMarkers: [],
    creditsUsed: 1,
    rateLimited: false,
    error: null,
    ...over,
  };
}

describe("classifyVerifiedListing", () => {
  it("fully green → accept, Outreach_Status=''", () => {
    const d = classifyVerifiedListing(fc());
    expect(d.outcome).toBe("accept");
    if (d.outcome === "accept") expect(d.outreachStatus).toBe("");
  });

  it("no condition signal (but clean) → REVIEW, Outreach_Status='Review' (soft flag)", () => {
    const d = classifyVerifiedListing(fc({ hasConditionSignal: false, matchedDistressKeywords: [] }));
    expect(d.outcome).toBe("review");
    if (d.outcome === "review") {
      expect(d.outreachStatus).toBe("Review");
      expect(d.reason).toBe("condition_signal_missing_flagged");
    }
  });

  it("renovated + NO distress signal → hard reject", () => {
    const d = classifyVerifiedListing(fc({ hasRenovatedLanguage: true, hasConditionSignal: false }));
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
  });

  it("wholesaler-excluded → hard reject (before the accept check)", () => {
    const d = classifyVerifiedListing(fc({ wholesalerExcluded: true, hasConditionSignal: false }));
    expect(d).toEqual({ outcome: "reject", reason: "wholesaler_excluded" });
  });

  it("wholesaler beats renovation (both hard rejects; wholesaler first)", () => {
    const d = classifyVerifiedListing(
      fc({ hasRenovatedLanguage: true, wholesalerExcluded: true, hasConditionSignal: false }),
    );
    expect(d).toEqual({ outcome: "reject", reason: "wholesaler_excluded" });
  });

  it("infra failures reject with the right reason", () => {
    expect(classifyVerifiedListing(fc({ credentialed: false })).outcome).toBe("reject");
    expect(classifyVerifiedListing(fc({ credentialed: false }))).toEqual({ outcome: "reject", reason: "firecrawl_not_configured" });
    expect(classifyVerifiedListing(fc({ rateLimited: true }))).toEqual({ outcome: "reject", reason: "firecrawl_rate_limited" });
    expect(classifyVerifiedListing(fc({ error: "boom" }))).toEqual({ outcome: "reject", reason: "firecrawl_error" });
    expect(classifyVerifiedListing(fc({ resolved: false }))).toEqual({ outcome: "reject", reason: "firecrawl_url_unresolved" });
    expect(classifyVerifiedListing(fc({ stillActive: false }))).toEqual({ outcome: "reject", reason: "firecrawl_inactive" });
  });

  it("review path is NOT a skip — it carries a write status", () => {
    const d = classifyVerifiedListing(fc({ hasConditionSignal: false }));
    // The cron writes this (Outreach_Status=Review) rather than dropping it.
    expect(d.outcome).not.toBe("reject");
  });
});

describe("classifyVerifiedListing — Phase 2 multi-signal accept", () => {
  const noText = { hasConditionSignal: false, matchedDistressKeywords: [] as string[] };

  it("no text condition but DOM ≥ 60 → accept", () => {
    const d = classifyVerifiedListing(fc(noText), { daysOnMarket: 60, priceReduced: false });
    expect(d.outcome).toBe("accept");
  });

  it("DOM just below threshold + no other signal → review", () => {
    const d = classifyVerifiedListing(fc(noText), { daysOnMarket: 59, priceReduced: false });
    expect(d.outcome).toBe("review");
  });

  it("no text condition but price reduced → accept", () => {
    const d = classifyVerifiedListing(fc(noText), { daysOnMarket: 5, priceReduced: true });
    expect(d.outcome).toBe("accept");
  });

  it("text condition alone still accepts regardless of DOM/price", () => {
    const d = classifyVerifiedListing(fc(), { daysOnMarket: 1, priceReduced: false });
    expect(d.outcome).toBe("accept");
  });

  it("none of the three signals → soft review", () => {
    const d = classifyVerifiedListing(fc(noText), { daysOnMarket: 10, priceReduced: false });
    expect(d.outcome).toBe("review");
    if (d.outcome === "review") expect(d.outreachStatus).toBe("Review");
  });

  it("renovation is OVERRIDDEN by a text condition signal → accept", () => {
    const d = classifyVerifiedListing(fc({ hasRenovatedLanguage: true }));
    expect(d.outcome).toBe("accept");
  });

  it("renovation is OVERRIDDEN by long DOM (no condition) → accept", () => {
    const d = classifyVerifiedListing(
      fc({ hasRenovatedLanguage: true, hasConditionSignal: false }),
      { daysOnMarket: 162, priceReduced: false },
    );
    expect(d.outcome).toBe("accept");
  });

  it("renovation is OVERRIDDEN by a price reduction (no condition) → accept", () => {
    const d = classifyVerifiedListing(
      fc({ hasRenovatedLanguage: true, hasConditionSignal: false }),
      { daysOnMarket: 5, priceReduced: true },
    );
    expect(d.outcome).toBe("accept");
  });

  it("renovation + NO distress signal at all → reject (renovation is decisive)", () => {
    const d = classifyVerifiedListing(
      fc({ hasRenovatedLanguage: true, hasConditionSignal: false }),
      { daysOnMarket: 5, priceReduced: false },
    );
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
  });

  it("inactive STILL beats every accept signal (hard reject, before accept)", () => {
    const d = classifyVerifiedListing(
      fc({ stillActive: false }),
      { daysOnMarket: 400, priceReduced: true },
    );
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_inactive" });
  });

  it("wholesaler STILL beats every accept signal", () => {
    const d = classifyVerifiedListing(
      fc({ wholesalerExcluded: true }),
      { daysOnMarket: 400, priceReduced: true },
    );
    expect(d).toEqual({ outcome: "reject", reason: "wholesaler_excluded" });
  });
});

describe("classifyVerifiedListing — new construction is a HARD reject (no override)", () => {
  it("new construction → reject new_construction_excluded", () => {
    const d = classifyVerifiedListing(fc({ isNewConstruction: true }));
    expect(d).toEqual({ outcome: "reject", reason: "new_construction_excluded" });
  });

  it("NO distress signal rescues new construction (condition + DOM + price all set)", () => {
    const d = classifyVerifiedListing(
      fc({ isNewConstruction: true, hasConditionSignal: true }),
      { daysOnMarket: 400, priceReduced: true },
    );
    expect(d).toEqual({ outcome: "reject", reason: "new_construction_excluded" });
  });

  it("inactive is checked before new construction (both reject)", () => {
    const d = classifyVerifiedListing(fc({ stillActive: false, isNewConstruction: true }));
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_inactive" });
  });

  it("new construction beats wholesaler + renovation", () => {
    const d = classifyVerifiedListing(
      fc({ isNewConstruction: true, wholesalerExcluded: true, hasRenovatedLanguage: true }),
    );
    expect(d).toEqual({ outcome: "reject", reason: "new_construction_excluded" });
  });
});
