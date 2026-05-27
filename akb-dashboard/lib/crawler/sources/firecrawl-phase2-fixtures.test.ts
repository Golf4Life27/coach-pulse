// Phase 2 rebalance regression fixtures — the 5 addresses the live
// ?debug=true forensics (78201) showed were FALSE-rejected at 0% accept, each
// of which must now classify ACCEPT once scoping + the multi-signal accept land:
//
//   1803 Mardell  — DOM 167 + price cut; soft "creative updates" copy. Was
//                   killed by "Year Renovated: —" + a NEW CONSTRUCTION comp.
//   1610 22nd     — "SOLD AS IS" subject copy; "renovated" only in the empty
//                   facts field.
//   915 Shearer   — motivated seller + fixer upper; killed by a 2025 "Listing
//                   Removed" row in Sale & Tax History.
//   942 W Lynwood — investor special + cash or hard money + fixer-upper (NOT a
//                   wholesaler exclusion); killed by a 2026 "Listing Removed".
//   1518 Waverly  — sold as-is + needs updates; killed by the Year-Renovated
//                   dash trick.
//
// Markdown blocks are REPRESENTATIVE reconstructions of the portal pages (the
// container has no Firecrawl key) modeling the exact noise the forensics
// described: a comps sidebar with a $790K NEW CONSTRUCTION comp, an em-dash
// "Year Renovated" facts row, and prior-year "Listing Removed" history rows.
// The operator re-validates against the live dry-run.

import { describe, it, expect } from "vitest";
import {
  detectRenovationLanguage,
  detectInactiveMarkers,
  classifyVerifiedListing,
  type FirecrawlVerifyResult,
  type ListingDistressSignals,
} from "./firecrawl";
import { evaluateListingContent } from "../intake-filter";
import { scopeSubjectText, scopeStatusText } from "./listing-text-scope";

/** Build a verify result the same way verifyListing now does: scope the raw
 *  markdown, then run the pure detectors on the scoped views. */
function verifyFromText(markdown: string): FirecrawlVerifyResult {
  const subjectText = scopeSubjectText(markdown);
  const statusText = scopeStatusText(markdown);
  const reno = detectRenovationLanguage(subjectText);
  const content = evaluateListingContent(subjectText);
  const inactive = detectInactiveMarkers(statusText);
  return {
    credentialed: true,
    resolved: true,
    url: "https://www.redfin.com/x",
    stillActive: inactive.length === 0,
    hasRenovatedLanguage: reno.matched,
    matchedKeywords: reno.matchedKeywords,
    wholesalerExcluded: content.wholesalerExcluded,
    matchedWholesalerKeywords: content.matchedWholesalerKeywords,
    hasConditionSignal: content.hasConditionSignal,
    matchedDistressKeywords: content.matchedDistressKeywords,
    matchedInactiveMarkers: inactive,
    creditsUsed: 1,
    rateLimited: false,
    error: null,
  };
}

// A comps sidebar carrying the renovation noise that, unscoped, false-matched
// "new construction" / "fully renovated" against the subject.
const COMPS = [
  "## Nearby similar homes",
  "- 99 Comparable Dr — NEW CONSTRUCTION 3D WALKTHROUGH — $790,497 — 6 beds 7.5 baths",
  "- 12 Other Ave — fully renovated turnkey, move-in ready — $625,000",
].join("\n");

// The em-dash facts row (em-dash = NOT renovated) that matched bare "renovated".
const FACTS_EMPTY_RENO = ["## Home facts", "Year Renovated: —", "Lot Size: 7,200 sqft"].join("\n");

// Prior-year history rows whose "Listing Removed" matched the inactive markers.
const HISTORY_REMOVED = [
  "## Sale & Tax History",
  "| 5/12/2025 | Listing Removed | $150,000 |",
  "| 3/04/2018 | Sold | $92,000 |",
].join("\n");

interface Case {
  name: string;
  markdown: string;
  signals: ListingDistressSignals;
  expect: { renovated: boolean; active: boolean; condition: boolean };
}

const CASES: Case[] = [
  {
    name: "1803 Mardell (DOM 167 + price cut; soft 'creative updates')",
    markdown: [
      "# 1803 Mardell Pl, San Antonio, TX 78201",
      "For sale — $145,000. 3 bed, 1 bath.",
      "Charming bungalow with creative updates throughout. Bring your vision.",
      FACTS_EMPTY_RENO,
      COMPS,
    ].join("\n"),
    signals: { daysOnMarket: 167, priceReduced: true },
    // No text condition signal — accepts purely on DOM + price cut.
    expect: { renovated: false, active: true, condition: false },
  },
  {
    name: "1610 22nd (SOLD AS IS; reno only in empty facts field)",
    markdown: [
      "# 1610 22nd St, San Antonio, TX 78201",
      "For sale — $129,000. 2 bed, 1 bath.",
      "SOLD AS IS. Cash buyers welcome, no repairs by seller.",
      FACTS_EMPTY_RENO,
      COMPS,
    ].join("\n"),
    signals: { daysOnMarket: 12, priceReduced: false },
    expect: { renovated: false, active: true, condition: true },
  },
  {
    name: "915 Shearer Blvd (motivated seller + fixer upper; 2025 Listing Removed)",
    markdown: [
      "# 915 Shearer Blvd, San Antonio, TX 78201",
      "For sale — $140,000. 3 bed, 2 bath.",
      "Motivated seller! Fixer upper sold as-is — great investor opportunity.",
      HISTORY_REMOVED,
      "## Schools",
      "Rated 5/10.",
      COMPS,
    ].join("\n"),
    signals: { daysOnMarket: 30, priceReduced: false },
    expect: { renovated: false, active: true, condition: true },
  },
  {
    name: "942 W Lynwood (investor special + cash or hard money; 2026 Listing Removed)",
    markdown: [
      "# 942 W Lynwood Ave, San Antonio, TX 78201",
      "For sale — $118,000. 2 bed, 1 bath.",
      "Investor special. Cash or hard money. Fixer-upper with tons of potential.",
      [
        "## Sale & Tax History",
        "| 1/08/2026 | Listing Removed | $125,000 |",
        "| 6/2019 | Sold | $70,000 |",
      ].join("\n"),
      COMPS,
    ].join("\n"),
    signals: { daysOnMarket: 8, priceReduced: false },
    expect: { renovated: false, active: true, condition: true },
  },
  {
    name: "1518 Waverly (sold as-is + needs updates; Year-Renovated dash)",
    markdown: [
      "# 1518 Waverly Ave, San Antonio, TX 78201",
      "For sale — $135,000. 3 bed, 1 bath.",
      "Sold as-is. Needs updates throughout — bring your contractor.",
      FACTS_EMPTY_RENO,
      COMPS,
    ].join("\n"),
    signals: { daysOnMarket: 20, priceReduced: false },
    expect: { renovated: false, active: true, condition: true },
  },
];

describe("Phase 2 fixtures — 5 false-rejected 78201 listings now classify ACCEPT", () => {
  for (const c of CASES) {
    it(`${c.name} → accept`, () => {
      const fc = verifyFromText(c.markdown);
      expect(fc.hasRenovatedLanguage).toBe(c.expect.renovated);
      expect(fc.stillActive).toBe(c.expect.active);
      expect(fc.hasConditionSignal).toBe(c.expect.condition);
      expect(fc.wholesalerExcluded).toBe(false);

      const d = classifyVerifiedListing(fc, c.signals);
      expect(d.outcome).toBe("accept");
      if (d.outcome === "accept") expect(d.outreachStatus).toBe("");
    });
  }
});
