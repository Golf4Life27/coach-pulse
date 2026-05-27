// Listing-text scoping tests (Phase 2 rebalance — comps / facts / history).

import { describe, it, expect } from "vitest";
import {
  stripCompsSection,
  stripEmptyFactsRows,
  stripHistorySection,
  isEmptyFactsRow,
  scopeSubjectText,
  scopeStatusText,
} from "./listing-text-scope";

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
