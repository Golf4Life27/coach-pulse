// Listing-text scoping tests (Phase 2 rebalance — comps / facts / history).

import { describe, it, expect } from "vitest";
import {
  stripCompsSection,
  stripEmptyFactsRows,
  stripHistorySection,
  stripInlineEmptyReno,
  stripInlineNewConstructionNo,
  isEmptyFactsRow,
  scopeSubjectText,
  scopeStatusText,
} from "./listing-text-scope";

// Verbatim Zillow "Facts & Features" row from the forensics — "New
// construction: No" embedded between dash separators.
const ZILLOW_FACTS_NEW_CONSTRUCTION_NO =
  "- Stucco - Foundation: Slab - Roof: Composition ###### Condition - Pre-Owned - New construction: No - Year built: 1949";

// Exact Redfin inline facts row from the live ?debug forensics — the whole
// table is one multi-field line, with "Year renovated —" embedded mid-line.
const REDFIN_FACTS_INLINE =
  "Stories 1 Lot width 50 ft. Lot depth 120 ft. Lot size 7,560 Sq. Ft. Year renovated — Finished Sq. Ft. 1,044 Unfinished Sq. Ft. — Total Sq. Ft. 1,044 Year built 1940";

describe("stripCompsSection", () => {
  it("drops everything from the 'Nearby similar homes' header onward", () => {
    const md = [
      "# 1610 22nd St",
      "Sold as-is. Investor opportunity.",
      "## Nearby similar homes",
      "- 99 Other St — NEW CONSTRUCTION — $790,497",
    ].join("\n");
    const out = stripCompsSection(md);
    expect(out).toContain("Sold as-is");
    expect(out).not.toContain("NEW CONSTRUCTION");
    expect(out).not.toContain("Nearby similar homes");
  });

  it("matches bare (non-#) comps headers and 'Recently sold'", () => {
    expect(stripCompsSection("subject copy\nNearby homes\ncomp line")).toBe("subject copy");
    expect(stripCompsSection("subject copy\n## Recently sold\ncomp line")).toBe("subject copy");
  });

  it("leaves a page with no comps section untouched", () => {
    const md = "# 123 Main\nFixer-upper, needs work.";
    expect(stripCompsSection(md)).toBe(md);
  });
});

describe("isEmptyFactsRow / stripEmptyFactsRows", () => {
  it("flags the em-dash 'Year Renovated' facts row", () => {
    expect(isEmptyFactsRow("Year Renovated: —")).toBe(true);
    expect(isEmptyFactsRow("Year Renovated —")).toBe(true);
    expect(isEmptyFactsRow("| Year Renovated | — |")).toBe(true);
    expect(isEmptyFactsRow("Year Renovated: N/A")).toBe(true);
  });

  it("does NOT flag a populated facts row or descriptive copy", () => {
    expect(isEmptyFactsRow("Year Renovated: 2015")).toBe(false);
    expect(isEmptyFactsRow("Fully renovated kitchen with new appliances.")).toBe(false);
    expect(isEmptyFactsRow("Sold as-is — bring your contractor")).toBe(false); // value present
  });

  it("removing the dash row kills the only 'renovated' match", () => {
    const md = ["Charming home, sold as-is.", "Year Renovated: —", "Lot Size: —"].join("\n");
    const out = stripEmptyFactsRows(md);
    expect(out.toLowerCase()).not.toContain("renovated");
    expect(out).toContain("sold as-is");
  });
});

describe("stripInlineEmptyReno", () => {
  it("removes the inline 'Year renovated —' token from a Redfin facts line", () => {
    const out = stripInlineEmptyReno(REDFIN_FACTS_INLINE);
    expect(out.toLowerCase()).not.toContain("renovated");
    // surrounding facts survive
    expect(out).toContain("Lot size 7,560 Sq. Ft.");
    expect(out).toContain("Finished Sq. Ft. 1,044");
    expect(out).toContain("Year built 1940");
  });

  it("handles en-dash and bare hyphen empty values", () => {
    expect(stripInlineEmptyReno("Year renovated – Finished").toLowerCase()).not.toContain("renovated");
    expect(stripInlineEmptyReno("Year renovated - Finished").toLowerCase()).not.toContain("renovated");
  });

  it("leaves a POPULATED renovation year intact (real signal)", () => {
    expect(stripInlineEmptyReno("Year renovated 2015 Finished")).toContain("renovated 2015");
    expect(stripInlineEmptyReno("Year renovated - 2015")).toContain("2015");
  });

  it("leaves descriptive renovation copy untouched", () => {
    const copy = "Fully renovated kitchen with new appliances.";
    expect(stripInlineEmptyReno(copy)).toBe(copy);
  });
});

describe("stripInlineNewConstructionNo", () => {
  it("removes 'New construction: No' from a Zillow facts row", () => {
    const out = stripInlineNewConstructionNo(ZILLOW_FACTS_NEW_CONSTRUCTION_NO);
    expect(out.toLowerCase()).not.toContain("new construction");
    // surrounding facts survive
    expect(out).toContain("Pre-Owned");
    expect(out).toContain("Year built: 1949");
  });

  it("does NOT strip 'New construction: Yes' (real positive signal)", () => {
    const out = stripInlineNewConstructionNo("Pre-Owned - New construction: Yes - Year built: 2025");
    expect(out.toLowerCase()).toContain("new construction");
  });

  it("leaves descriptive 'new construction' copy untouched", () => {
    const copy = "Brand new construction, never lived in.";
    expect(stripInlineNewConstructionNo(copy)).toBe(copy);
  });

  it("scopeSubjectText kills the 'new construction' renovation match end-to-end", () => {
    expect(scopeSubjectText(ZILLOW_FACTS_NEW_CONSTRUCTION_NO).toLowerCase()).not.toContain("new construction");
  });
});

describe("stripHistorySection", () => {
  it("drops 'Listing Removed' rows under Sale & Tax History but keeps top status", () => {
    const md = [
      "# 915 Shearer Blvd",
      "For sale — $140,000. Motivated seller, fixer upper.",
      "## Sale & Tax History",
      "- 5/2025 — Listing Removed — $150,000",
      "- 3/2018 — Sold — $90,000",
      "## Schools",
      "Rated 6/10",
    ].join("\n");
    const out = stripHistorySection(md);
    expect(out).toContain("Motivated seller");
    expect(out).not.toContain("Listing Removed");
    expect(out).toContain("## Schools"); // section after history resumes
  });

  it("preserves a genuine top-of-page inactive banner", () => {
    const md = [
      "# 1 Dead St",
      "This listing is no longer available.",
      "## Sale & Tax History",
      "- 1/2020 — Listed — $100,000",
    ].join("\n");
    const out = stripHistorySection(md);
    expect(out).toContain("no longer available");
  });
});

describe("scopeSubjectText / scopeStatusText composition", () => {
  it("subject text strips both comps and empty facts rows", () => {
    const md = [
      "Sold as-is, needs work.",
      "Year Renovated: —",
      "## Nearby similar homes",
      "- comp NEW CONSTRUCTION $790,497",
    ].join("\n");
    const out = scopeSubjectText(md);
    expect(out).toContain("Sold as-is");
    expect(out.toLowerCase()).not.toContain("renovated");
    expect(out).not.toContain("NEW CONSTRUCTION");
  });

  it("status text strips comps and history", () => {
    const md = [
      "For sale — motivated seller.",
      "## Price history",
      "- 2024 — Listing Removed",
      "## Nearby homes",
      "- comp — no longer available",
    ].join("\n");
    const out = scopeStatusText(md);
    expect(out).toContain("motivated seller");
    expect(out).not.toContain("Listing Removed");
    expect(out).not.toContain("no longer available");
  });

  it("null / empty input → empty string", () => {
    expect(scopeSubjectText(null)).toBe("");
    expect(scopeStatusText(undefined)).toBe("");
  });
});
