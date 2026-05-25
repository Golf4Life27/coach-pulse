// INV-028 (merged) — Firecrawl verification pure-helper tests.

import { describe, it, expect } from "vitest";
import {
  detectRenovationLanguage,
  detectStillActive,
  buildSearchQuery,
  pickListingResult,
  RENOVATION_EXCLUSION_KEYWORDS,
} from "./firecrawl";

describe("detectRenovationLanguage", () => {
  it("flags fully renovated", () => {
    const r = detectRenovationLanguage("Beautiful home, fully renovated in 2024 with new everything.");
    expect(r.matched).toBe(true);
    expect(r.matchedKeywords).toContain("fully renovated");
    expect(r.matchedKeywords).toContain("renovated");
  });
  it("flags turnkey / move-in ready variants", () => {
    expect(detectRenovationLanguage("Turn-key investment, move in ready!").matched).toBe(true);
    expect(detectRenovationLanguage("TURNKEY rental").matchedKeywords).toContain("turnkey");
  });
  it("flags new construction / rehabbed", () => {
    expect(detectRenovationLanguage("New construction, never lived in").matched).toBe(true);
    expect(detectRenovationLanguage("Fully rehabbed, rehab complete").matched).toBe(true);
  });
  it("does NOT flag a distressed/original listing", () => {
    const r = detectRenovationLanguage("Handyman special, needs work, sold as-is. Original 1960s condition.");
    expect(r.matched).toBe(false);
    expect(r.matchedKeywords).toEqual([]);
  });
  it("case-insensitive", () => {
    expect(detectRenovationLanguage("COMPLETELY REMODELED").matched).toBe(true);
  });
  it("null/empty → no match", () => {
    expect(detectRenovationLanguage(null).matched).toBe(false);
    expect(detectRenovationLanguage("").matched).toBe(false);
  });
  it("keyword list contains the operator-specified terms", () => {
    for (const k of ["fully renovated", "turnkey", "move-in ready", "new construction", "rehabbed", "all new"]) {
      expect(RENOVATION_EXCLUSION_KEYWORDS).toContain(k);
    }
  });
});

describe("detectStillActive", () => {
  it("true for an active listing page", () => {
    expect(detectStillActive("For sale. $185,000. 3 bed 2 bath. Schedule a tour.")).toBe(true);
  });
  it("false on inactive markers", () => {
    expect(detectStillActive("This home is no longer available")).toBe(false);
    expect(detectStillActive("Sale pending — accepting backups")).toBe(false);
    expect(detectStillActive("Off market")).toBe(false);
    expect(detectStillActive("This home sold on 4/1/2026")).toBe(false);
  });
  it("true (don't override RentCast) when no text", () => {
    expect(detectStillActive(null)).toBe(true);
    expect(detectStillActive("")).toBe(true);
  });
});

describe("buildSearchQuery", () => {
  it("appends 'for sale' to the address", () => {
    expect(buildSearchQuery("123 Main St, San Antonio, TX 78210")).toBe("123 Main St, San Antonio, TX 78210 for sale");
  });
  it("handles null", () => {
    expect(buildSearchQuery(null)).toBe("for sale");
  });
});

describe("pickListingResult", () => {
  const addr = "23 Fields Ave, Memphis, TN 38109";
  it("prefers a portal domain that matches the street number", () => {
    const web = [
      { url: "https://example.com/blog/23-tips", title: "23 tips", markdown: "unrelated" },
      { url: "https://www.redfin.com/TN/Memphis/23-Fields-Ave-38109/home/87658196", title: "23 Fields Ave", markdown: "23 Fields Ave for sale" },
    ];
    const pick = pickListingResult(web, addr);
    expect(pick?.url).toContain("redfin.com");
  });
  it("returns null when nothing matches the subject street number", () => {
    const web = [{ url: "https://www.zillow.com/homes/999-Other-St", title: "999 Other St", markdown: "999 Other St" }];
    expect(pickListingResult(web, addr)).toBeNull();
  });
  it("falls back to first subject-matching result when no preferred domain", () => {
    const web = [{ url: "https://mlslocal.example/listing/23-fields", title: "23 Fields Ave", markdown: "23 Fields Ave Memphis" }];
    expect(pickListingResult(web, addr)?.url).toContain("mlslocal");
  });
  it("empty results → null", () => {
    expect(pickListingResult([], addr)).toBeNull();
  });
});
