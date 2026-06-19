// On-deck (CONVEYOR M4): verify the renovation HARD-VETO keyword scan reads
// the listing DESCRIPTION, not just structured fields. Fixture: 14303 Hubbell
// St — description "This Turnkey duplex …". "turnkey" is a hard-veto keyword.
//
// Finding (real record recn6XGAMKEmsU219, status=Emailed, 2026-06-16): the
// veto LOGIC is sound — scopeSubjectText preserves the subject description and
// detectRenovationLanguage trips on "turnkey". The miss was upstream: that
// record's stored description field was EMPTY and it was added via a
// Zillow/Realcomp path, so the "Turnkey" text never reached the scanned
// markdown. This test guards the logic (a regression that strips descriptions,
// or drops "turnkey" from the keyword set, fails here).

import { describe, it, expect } from "vitest";
import { detectRenovationLanguage } from "@/lib/crawler/sources/firecrawl";
import { scopeSubjectText } from "@/lib/crawler/sources/listing-text-scope";

const HUBBELL_MARKDOWN = [
  "# 14303 Hubbell St, Detroit, MI 48227",
  "",
  "This Turnkey duplex is fully occupied and rent-ready — a great investment.",
  "",
  "## Nearby similar homes",
  "- 123 Other St — newly renovated, move-in ready (a COMP, must NOT count)",
].join("\n");

describe("renovation hard-veto scans the listing description (14303 Hubbell)", () => {
  it("scopeSubjectText keeps the subject description but drops the comps block", () => {
    const scoped = scopeSubjectText(HUBBELL_MARKDOWN).toLowerCase();
    expect(scoped).toContain("turnkey duplex"); // subject description preserved
    expect(scoped).not.toContain("nearby similar homes"); // comps sidebar dropped
    expect(scoped).not.toContain("123 other st"); // comp's own reno language dropped
  });

  it("'This Turnkey duplex' description trips the renovation hard-veto", () => {
    const reno = detectRenovationLanguage(scopeSubjectText(HUBBELL_MARKDOWN));
    expect(reno.matched).toBe(true);
    expect(reno.matchedKeywords).toContain("turnkey");
  });

  it("the bare description string alone vetoes (the scan reads description text)", () => {
    expect(detectRenovationLanguage("This Turnkey duplex is rent-ready").matched).toBe(true);
  });
});
