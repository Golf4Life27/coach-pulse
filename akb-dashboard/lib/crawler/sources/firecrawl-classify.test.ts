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

describe("classifyVerifiedListing — renovation is a HARD VETO (2026-05-27 amendment)", () => {
  const noText = { hasConditionSignal: false, matchedDistressKeywords: [] as string[] };

  it("DOM ≥ 60 alone no longer accepts → review (DOM is diagnostic only)", () => {
    const d = classifyVerifiedListing(fc(noText), { daysOnMarket: 500, priceReduced: false });
    expect(d.outcome).toBe("review");
  });

  it("price reduced alone no longer accepts → review (priceReduced is diagnostic only)", () => {
    const d = classifyVerifiedListing(fc(noText), { daysOnMarket: 5, priceReduced: true });
    expect(d.outcome).toBe("review");
  });

  it("text condition signal still accepts (the surviving distress accept)", () => {
    const d = classifyVerifiedListing(fc(), { daysOnMarket: 1, priceReduced: false });
    expect(d.outcome).toBe("accept");
  });

  it("none of the signals → soft review", () => {
    const d = classifyVerifiedListing(fc(noText), { daysOnMarket: 10, priceReduced: false });
    expect(d.outcome).toBe("review");
    if (d.outcome === "review") expect(d.outreachStatus).toBe("Review");
  });

  it("renovation is NO LONGER overridden by a text condition signal → reject", () => {
    const d = classifyVerifiedListing(fc({ hasRenovatedLanguage: true, hasConditionSignal: true }));
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
  });

  it("renovation is NO LONGER overridden by long DOM → reject", () => {
    const d = classifyVerifiedListing(
      fc({ hasRenovatedLanguage: true, hasConditionSignal: false }),
      { daysOnMarket: 500, priceReduced: false },
    );
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
  });

  it("renovation is NO LONGER overridden by a price reduction → reject", () => {
    const d = classifyVerifiedListing(
      fc({ hasRenovatedLanguage: true, hasConditionSignal: false }),
      { daysOnMarket: 5, priceReduced: true },
    );
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
  });

  it("inactive STILL beats the veto tier (hard reject, checked first)", () => {
    const d = classifyVerifiedListing(
      fc({ stillActive: false, hasRenovatedLanguage: true }),
      { daysOnMarket: 400, priceReduced: true },
    );
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_inactive" });
  });

  it("wholesaler is checked before renovation (both hard rejects)", () => {
    const d = classifyVerifiedListing(
      fc({ wholesalerExcluded: true, hasRenovatedLanguage: true }),
      { daysOnMarket: 400, priceReduced: true },
    );
    expect(d).toEqual({ outcome: "reject", reason: "wholesaler_excluded" });
  });
});

describe("classifyVerifiedListing — 1138 Santa Anna regression (the live false-accept)", () => {
  it("'remodeled' + priceReduced + DOM 177 → reject firecrawl_renovated", () => {
    // The exact live false-accept: matched "remodeled" (hasRenovatedLanguage)
    // but the old multi-signal branch let priceReduced + DOM 177 override it to
    // accept → it auto-promoted and got texted in the first live H2 fire.
    const d = classifyVerifiedListing(
      fc({ hasRenovatedLanguage: true, matchedKeywords: ["remodeled"], hasConditionSignal: false }),
      { daysOnMarket: 177, priceReduced: true },
    );
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
  });

  it("renovated + DOM 500 → reject firecrawl_renovated", () => {
    const d = classifyVerifiedListing(
      fc({ hasRenovatedLanguage: true, matchedKeywords: ["renovated"], hasConditionSignal: false }),
      { daysOnMarket: 500, priceReduced: false },
    );
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
  });

  it("fully remodeled + priceReduced → reject firecrawl_renovated", () => {
    const d = classifyVerifiedListing(
      fc({ hasRenovatedLanguage: true, matchedKeywords: ["fully remodeled"], hasConditionSignal: false }),
      { daysOnMarket: 5, priceReduced: true },
    );
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
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
