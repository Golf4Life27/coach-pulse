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
    portfolioSellerDetected: false,
    matchedPortfolioKeywords: [],    creditsUsed: 1,
    rateLimited: false,
    paymentRequired: false,    error: null,
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

  it("402 payment_required is a DISTINCT reason, ahead of the generic error path", () => {
    // A 402 sets both paymentRequired AND error (the message). The classifier
    // must surface firecrawl_payment_required, NOT firecrawl_error, so the
    // cron keeps the ZIP DUE and the CRITICAL alert fires.
    const d = classifyVerifiedListing(fc({ paymentRequired: true, error: "Firecrawl 402 Payment Required" }));
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_payment_required" });
  });

  it("review path is NOT a skip — it carries a write status", () => {
    const d = classifyVerifiedListing(fc({ hasConditionSignal: false }));
    // The cron writes this (Outreach_Status=Review) rather than dropping it.
    expect(d.outcome).not.toBe("reject");
  });
});

describe("classifyVerifiedListing — renovation is a HARD VETO (2026-05-27 amendment)", () => {
  const noText = { hasConditionSignal: false, matchedDistressKeywords: [] as string[] };

  // SUPERSEDED 2026-07-22 (operator ruling: "distressed in some fashion,
  // either by DOM or physically") — aged DOM / price cut accept again, at
  // tier 8, strictly BELOW the hard vetoes. The veto tests above are the
  // surviving guard from the 2026-05-27 amendment.
  it("aged DOM alone accepts at tier 8 (2026-07-22 ruling; was diagnostic-only)", () => {
    const d = classifyVerifiedListing(fc(noText), { daysOnMarket: 500, priceReduced: false });
    expect(d.outcome).toBe("accept");
    if (d.outcome === "accept") expect(d.acceptBasis).toBe("aged_dom");
  });

  it("price cut alone accepts at tier 8 (2026-07-22 ruling; was diagnostic-only)", () => {
    const d = classifyVerifiedListing(fc(noText), { daysOnMarket: 5, priceReduced: true });
    expect(d.outcome).toBe("accept");
    if (d.outcome === "accept") expect(d.acceptBasis).toBe("price_cut");
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

// ─────────────────────────────────────────────────────────────────────
// buildResolvedResult — the search→scrape rework's markdown classifier
// (operator 2026-06-08). Post-scrape street-number confirmation guards
// against classifying the wrong listing now that we pick BEFORE scraping.
// ─────────────────────────────────────────────────────────────────────

import { buildResolvedResult } from "./firecrawl";

describe("buildResolvedResult", () => {
  const md = "346 Modder Ave, Memphis TN. Sold as-is, motivated seller. 3 bed 2 bath.";

  it("resolves + classifies when the street number is present in the markdown", () => {
    const r = buildResolvedResult(md, "https://redfin.com/.../346-Modder-Ave", "346 Modder Ave", 2, false);
    expect(r.resolved).toBe(true);
    expect(r.url).toContain("346-Modder-Ave");
    expect(r.hasConditionSignal).toBe(true); // "as-is / motivated"
    expect(r.creditsUsed).toBe(2);
  });

  it("returns UNRESOLVED when the scraped page lacks the subject street number (wrong listing)", () => {
    // The scrape landed on a different property — don't classify it.
    const wrong = "9999 Someother St. Beautiful turnkey new construction.";
    const r = buildResolvedResult(wrong, "https://redfin.com/.../9999-Someother", "346 Modder Ave", 2, false);
    expect(r.resolved).toBe(false);
    // credits still counted (we paid for the scrape)
    expect(r.creditsUsed).toBe(2);
  });

  it("does NOT block when the subject address has no leading street number", () => {
    const r = buildResolvedResult("Some condo listing, as-is.", "https://x", "Unit B Riverside", 2, false);
    // no street number to confirm → trust the pick, classify
    expect(r.resolved).toBe(true);
  });

  it("renovation language still hard-vetoes via the shared classifier", () => {
    const r = buildResolvedResult("346 Modder Ave. Fully remodeled, renovated kitchen.", "https://x/346", "346 Modder Ave", 2, false);
    expect(r.resolved).toBe(true);
    expect(r.hasRenovatedLanguage).toBe(true);
  });
});

// ── Tier-8 distress accepts (operator ruling 2026-07-22) ─────────────────
// Price cut / aged DOM accept BELOW the hard vetoes. The Santa Anna guard
// (2026-05-27, Spine rec6DhIgAIH50jkJT) must hold: a renovated turnkey with
// screaming candidate-side distress signals still rejects.

describe("classifyVerifiedListing — tier-8 distress accepts (DOM / price cut)", () => {
  const clean = { hasConditionSignal: false, matchedDistressKeywords: [] };

  it("SANTA ANNA PIN: renovated + priceReduced + DOM 177 → still hard reject", () => {
    const d = classifyVerifiedListing(
      fc({ ...clean, hasRenovatedLanguage: true }),
      { daysOnMarket: 177, priceReduced: true },
    );
    expect(d).toEqual({ outcome: "reject", reason: "firecrawl_renovated" });
  });

  it("new construction + aged DOM → still hard reject", () => {
    const d = classifyVerifiedListing(
      fc({ ...clean, isNewConstruction: true }),
      { daysOnMarket: 200, priceReduced: false },
    );
    expect(d).toEqual({ outcome: "reject", reason: "new_construction_excluded" });
  });

  it("clean copy + aged DOM (>= mark) → accept, basis aged_dom", () => {
    const d = classifyVerifiedListing(fc(clean), { daysOnMarket: 120, priceReduced: false }, { domMark: 90 });
    expect(d.outcome).toBe("accept");
    if (d.outcome === "accept") expect(d.acceptBasis).toBe("aged_dom");
  });

  it("clean copy + price cut → accept, basis price_cut", () => {
    const d = classifyVerifiedListing(fc(clean), { daysOnMarket: 12, priceReduced: true });
    expect(d.outcome).toBe("accept");
    if (d.outcome === "accept") expect(d.acceptBasis).toBe("price_cut");
  });

  it("clean copy + fresh DOM + no cut → still Review (no lowballing clean fresh listings)", () => {
    const d = classifyVerifiedListing(fc(clean), { daysOnMarket: 30, priceReduced: false }, { domMark: 90 });
    expect(d.outcome).toBe("review");
    if (d.outcome === "review") expect(d.reason).toBe("condition_signal_missing_flagged");
  });

  it("condition-signal accept carries basis condition_signal (existing lane labeled)", () => {
    const d = classifyVerifiedListing(fc(), { daysOnMarket: null, priceReduced: false });
    expect(d.outcome).toBe("accept");
    if (d.outcome === "accept") expect(d.acceptBasis).toBe("condition_signal");
  });

  it("sqft-mismatch armor still precedes the tier-8 accepts", () => {
    const md = "346 Modder Ave. 2,400 sqft of space.";
    const r = buildResolvedResult(md, "https://x/346", "346 Modder Ave", 1, false);
    const d = classifyVerifiedListing(
      { ...r, ...clean },
      { daysOnMarket: 150, priceReduced: true },
      { sourceSqft: 1200 },
    );
    expect(d.outcome).toBe("review");
    if (d.outcome === "review") expect(d.reason).toBe("sqft_mismatch_flagged");
  });
});
