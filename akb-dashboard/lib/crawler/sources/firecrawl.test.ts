// INV-028 (merged) — Firecrawl verification pure-helper tests.

import { describe, it, expect } from "vitest";
import {
  detectRenovationLanguage,
  detectStillActive,
  detectInactiveMarkers,
  detectNewConstruction,
  extractPhraseContext,
  buildDebugContexts,
  buildSearchQuery,
  pickListingResult,
  RENOVATION_EXCLUSION_KEYWORDS,
} from "./firecrawl";

describe("detectNewConstruction (hard exclusion signals)", () => {
  const NOW = new Date("2026-05-27T00:00:00Z");
  it("Zillow 'New construction: Yes' → new", () => {
    const r = detectNewConstruction("Pre-Owned: No - New construction: Yes - Year built: 2025", NOW);
    expect(r.isNew).toBe(true);
    expect(r.signals).toContain("new_construction_yes");
  });
  it("Redfin 'NEW CONSTRUCTION' banner → new", () => {
    const r = detectNewConstruction("NEW CONSTRUCTION\n3 bed, 2 bath", NOW);
    expect(r.isNew).toBe(true);
    expect(r.signals).toContain("new_construction_banner");
  });
  it("year_built within last 2 years → new", () => {
    expect(detectNewConstruction("Year built 2025", NOW).isNew).toBe(true);
    expect(detectNewConstruction("Year built: 2024", NOW).isNew).toBe(true);
    expect(detectNewConstruction("Built in 2026", NOW).isNew).toBe(true);
  });
  it("old year_built → NOT new", () => {
    expect(detectNewConstruction("Year built 1949", NOW).isNew).toBe(false);
    expect(detectNewConstruction("Year built: 2023", NOW).isNew).toBe(false);
  });
  it("no new-construction signal → NOT new", () => {
    expect(detectNewConstruction("Charming 1940s bungalow, sold as-is.", NOW).isNew).toBe(false);
    expect(detectNewConstruction("", NOW).isNew).toBe(false);
    expect(detectNewConstruction(null, NOW).isNew).toBe(false);
  });
});

describe("detectInactiveMarkers / detectStillActive (INV debug)", () => {
  it("returns the matched inactive marker phrases", () => {
    expect(detectInactiveMarkers("This listing is no longer available as of today.")).toEqual(["no longer available"]);
    expect(detectInactiveMarkers("Active 3/2 ranch, motivated seller.")).toEqual([]);
  });
  it("stays consistent with detectStillActive", () => {
    expect(detectStillActive("listing removed by agent")).toBe(false);
    expect(detectStillActive("great as-is opportunity")).toBe(true);
    expect(detectStillActive(null)).toBe(true);
  });
});

describe("extractPhraseContext (INV debug)", () => {
  it("returns a trimmed, ellipsised snippet around the first match", () => {
    const text = "A".repeat(200) + " fully renovated kitchen " + "B".repeat(200);
    const snip = extractPhraseContext(text, "fully renovated", 20);
    expect(snip).toContain("fully renovated");
    expect(snip!.startsWith("…")).toBe(true);
    expect(snip!.endsWith("…")).toBe(true);
  });
  it("is case-insensitive and collapses whitespace in the snippet; null when absent", () => {
    // Matching is raw-substring (mirrors the classifiers' lc.includes); the
    // snippet's own internal whitespace is collapsed for readability.
    expect(extractPhraseContext("Move-In READY home", "move-in ready")).toBe("Move-In READY home");
    expect(extractPhraseContext("a\n\nfully renovated\tkitchen", "fully renovated")).toBe("a fully renovated kitchen");
    expect(extractPhraseContext("nothing here", "turnkey")).toBeNull();
    expect(extractPhraseContext(null, "x")).toBeNull();
  });
});

describe("buildDebugContexts (INV debug)", () => {
  it("groups context snippets by category, skipping phrases not present", () => {
    const md = "Charming as-is fixer. No wholesalers please. Recently fully renovated bath.";
    const out = buildDebugContexts(md, [
      { category: "renovation", phrases: ["fully renovated"] },
      { category: "wholesaler", phrases: ["no wholesalers"] },
      { category: "distress", phrases: ["as-is", "probate"] },
    ]);
    expect(out.map((c) => c.category)).toEqual(["renovation", "wholesaler", "distress"]);
    expect(out.find((c) => c.category === "distress")!.phrase).toBe("as-is");
    expect(out.every((c) => c.snippet.length > 0)).toBe(true);
  });
});

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
  it("false only on unambiguous removal markers", () => {
    expect(detectStillActive("This home is no longer available")).toBe(false);
    expect(detectStillActive("Listing removed by the agent")).toBe(false);
    expect(detectStillActive("This property is no longer on the market")).toBe(false);
  });
  it("does NOT false-flag boilerplate-prone phrases (2026-05-26 regression)", () => {
    // These appear in Zillow/Redfin nearby-homes, recently-sold, and
    // pending-comps boilerplate on pages whose subject listing is active.
    expect(detectStillActive("Sale pending — accepting backups")).toBe(true);
    expect(detectStillActive("Off market")).toBe(true);
    expect(detectStillActive("This home sold on 4/1/2026")).toBe(true);
  });
  it("stays active on a real listing page that contains comp boilerplate", () => {
    // Active subject listing whose page also lists nearby homes that are
    // off-market / recently sold — the full-page scan must not drop it.
    const page = [
      "For sale — $145,000. 3 bed 2 bath. Sold as-is, motivated seller.",
      "Nearby homes:",
      "412 Oak — Off market",
      "418 Oak — Sold on 3/2/2026",
      "424 Oak — Sale pending",
    ].join("\n");
    expect(detectStillActive(page)).toBe(true);
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
