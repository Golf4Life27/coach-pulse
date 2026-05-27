// Regression fixtures for the e08a81d ship-blocker: 3 active distress
// listings were auto-accepted pre-fix then dropped post-fix. This pins the
// full pure verify→classify pipeline (detectStillActive +
// detectRenovationLanguage + evaluateListingContent → classifyVerifiedListing)
// so each listing classifies ACCEPT.
//
// NOTE: the container has no Firecrawl key, so these markdown blocks are
// REPRESENTATIVE reconstructions of the portal pages (active subject listing
// + the nearby-homes / recently-sold / pending-comps boilerplate that caused
// the full-page substring scan to false-flag the subject as inactive), not
// the exact scraped bytes. The operator re-scrapes the live zpids out of band.
//
// El Paso (zpid 26222373, 3 DOM) and Salinas (zpid 26124490, 10 DOM) were in
// reality dropped at the INTAKE DOM floor (listed_date_too_new), NOT at the
// Firecrawl inactive check — that floor is removed in intake-filter.ts and
// covered by intake-filter.test.ts. They are included here too because, once
// they reach Firecrawl, their pages must also classify ACCEPT.

import { describe, it, expect } from "vitest";
import {
  detectStillActive,
  detectRenovationLanguage,
  classifyVerifiedListing,
  type FirecrawlVerifyResult,
} from "./firecrawl";
import { evaluateListingContent } from "../intake-filter";

/** Assemble a FirecrawlVerifyResult from scraped page text the same way
 *  verifyListing does, with green infra (credentialed/resolved). */
function verifyFromText(markdown: string): FirecrawlVerifyResult {
  const reno = detectRenovationLanguage(markdown);
  const content = evaluateListingContent(markdown);
  return {
    credentialed: true,
    resolved: true,
    url: "https://www.zillow.com/homedetails/x",
    stillActive: detectStillActive(markdown),
    hasRenovatedLanguage: reno.matched,
    matchedKeywords: reno.matchedKeywords,
    wholesalerExcluded: content.wholesalerExcluded,
    matchedWholesalerKeywords: content.matchedWholesalerKeywords,
    hasConditionSignal: content.hasConditionSignal,
    matchedDistressKeywords: content.matchedDistressKeywords,
    isNewConstruction: false,
    matchedNewConstructionSignals: [],
    matchedInactiveMarkers: [],
    creditsUsed: 1,
    rateLimited: false,
    error: null,
  };
}

const COMP_BOILERPLATE = [
  "",
  "## Nearby homes",
  "- 412 W Houston St — Off market — $132,000",
  "- 418 W Houston St — Sold on 3/2/2026 — $128,500",
  "- 424 W Houston St — Sale pending",
  "## Recently sold",
  "- This home sold on 4/1/2026 for $140,000 (comparable)",
].join("\n");

const FIXTURES: Array<{ name: string; zpid: string; markdown: string }> = [
  {
    name: "3719 W Houston St (42 DOM)",
    zpid: "26138273",
    markdown: [
      "# 3719 W Houston St, San Antonio, TX 78207",
      "For sale — $135,000. 3 bed, 1 bath, 1,040 sqft.",
      "Sold as-is. Motivated seller, bring offers. Needs work — great investor opportunity.",
      "Listed 42 days ago.",
      COMP_BOILERPLATE,
    ].join("\n"),
  },
  {
    name: "2810 W Salinas St (10 DOM)",
    zpid: "26124490",
    markdown: [
      "# 2810 W Salinas St, San Antonio, TX 78207",
      "For sale — $119,900. 2 bed, 1 bath.",
      "Handyman special, cash only. Estate sale — priced to sell.",
      "Listed 10 days ago.",
      COMP_BOILERPLATE,
    ].join("\n"),
  },
  {
    name: "3410 El Paso St (3 DOM)",
    zpid: "26222373",
    markdown: [
      "# 3410 El Paso St, San Antonio, TX 78207",
      "For sale — $99,000. 3 bed, 2 bath.",
      "Fixer-upper, needs TLC. Investor special, won't qualify for financing.",
      "Just listed 3 days ago.",
      COMP_BOILERPLATE,
    ].join("\n"),
  },
];

describe("e08a81d regression fixtures — 3 active distress listings classify ACCEPT", () => {
  for (const f of FIXTURES) {
    it(`${f.name} (zpid ${f.zpid}) → accept`, () => {
      const fc = verifyFromText(f.markdown);
      // The subject listing is active despite comp boilerplate mentioning
      // off-market / sold / pending nearby homes.
      expect(fc.stillActive).toBe(true);
      expect(fc.hasRenovatedLanguage).toBe(false);
      expect(fc.wholesalerExcluded).toBe(false);
      expect(fc.hasConditionSignal).toBe(true);

      const d = classifyVerifiedListing(fc);
      expect(d.outcome).toBe("accept");
      if (d.outcome === "accept") expect(d.outreachStatus).toBe("");
    });
  }
});
