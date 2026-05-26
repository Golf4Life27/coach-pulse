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

  it("renovated → hard reject (even if no condition signal)", () => {
    const d = classifyVerifiedListing(fc({ hasRenovatedLanguage: true, hasConditionSignal: false }));
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
  });

  it("wholesaler-excluded → hard reject (before condition check)", () => {
    const d = classifyVerifiedListing(fc({ wholesalerExcluded: true, hasConditionSignal: false }));
    expect(d).toEqual({ outcome: "reject", reason: "wholesaler_excluded" });
  });

  it("renovation beats wholesaler beats condition (ordering)", () => {
    const d = classifyVerifiedListing(
      fc({ hasRenovatedLanguage: true, wholesalerExcluded: true, hasConditionSignal: false }),
    );
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
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
