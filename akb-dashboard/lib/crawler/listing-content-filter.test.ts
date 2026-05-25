// Listing-content filter tests (wholesaler-exclusion + condition-signal).

import { describe, it, expect } from "vitest";
import {
  evaluateListingContent,
  matchKeywordsWordBoundary,
  WHOLESALER_EXCLUSION_KEYWORDS,
  DISTRESS_CONDITION_KEYWORDS,
} from "./intake-filter";

// Actual vibe-copy from the first dry-run (1010 W Lynwood) — zero condition
// signal either direction.
const LYNWOOD_VIBE = `If you've been searching for a home with personality, location, and livability — this is it. Tucked into one of San Antonio's most established central neighborhoods, natural light fills the space, creating a warm and welcoming atmosphere throughout.`;

const wholesalerOf = (t: string) => evaluateListingContent(t).wholesalerExcluded;
const conditionOf = (t: string) => evaluateListingContent(t).hasConditionSignal;

describe("wholesaler_excluded detection", () => {
  it("'no wholesalers' → excluded", () => {
    expect(wholesalerOf("Great deal but no wholesalers please.")).toBe(true);
  });
  it("'end users only' → excluded", () => {
    expect(wholesalerOf("End users only, serious buyers.")).toBe(true);
  });
  it("Santa Anna pattern → excluded", () => {
    expect(wholesalerOf("CASH OR HARD MONEY ONLY - END USERS NO WHOLESALERS")).toBe(true);
  });
  it("no-investors / no-flippers / non-assignable variants → excluded", () => {
    expect(wholesalerOf("No investors, owner occupants only.")).toBe(true);
    expect(wholesalerOf("No flippers. Principals only.")).toBe(true);
    expect(wholesalerOf("Contract is non-assignable.")).toBe(true);
  });
  it("clean distress listing without buyer-type language → NOT excluded", () => {
    expect(wholesalerOf("Foundation repair needed, motivated seller, sold as-is.")).toBe(false);
  });
});

describe("condition_signal_missing detection", () => {
  it("Lynwood vibe-copy → no condition signal", () => {
    expect(conditionOf(LYNWOOD_VIBE)).toBe(false);
  });
  it("distress disclosure → has condition signal", () => {
    expect(conditionOf("Handyman special, needs TLC, bring your contractor.")).toBe(true);
    expect(conditionOf("Foundation repair, motivated seller.")).toBe(true);
    expect(conditionOf("Estate sale, sold as is, cash only.")).toBe(true);
  });
  it("empty / null description → no condition signal", () => {
    expect(conditionOf("")).toBe(false);
    expect(evaluateListingContent(null).hasConditionSignal).toBe(false);
    expect(evaluateListingContent(undefined).hasConditionSignal).toBe(false);
  });
});

describe("combined evaluation (cron applies wholesaler-first ordering)", () => {
  it("'needs updating but no wholesalers' → wholesalerExcluded true (even though condition present)", () => {
    const r = evaluateListingContent("Needs updating but no wholesalers.");
    expect(r.wholesalerExcluded).toBe(true); // cron rejects on this first
    expect(r.hasConditionSignal).toBe(true); // condition also present, but wholesaler wins
  });
  it("distress without exclusion → passes both (would intake)", () => {
    const r = evaluateListingContent("Fixer-upper, foundation issue, must sell.");
    expect(r.wholesalerExcluded).toBe(false);
    expect(r.hasConditionSignal).toBe(true);
  });
});

describe("case-insensitive", () => {
  it("uppercase keywords match", () => {
    expect(wholesalerOf("NO WHOLESALERS")).toBe(true);
    expect(conditionOf("MOTIVATED SELLER")).toBe(true);
  });
});

describe("word-boundary matching (not substring)", () => {
  it("'probate' matches but 'approbate' does NOT", () => {
    expect(matchKeywordsWordBoundary("Probate sale, must close fast.", DISTRESS_CONDITION_KEYWORDS)).toContain("probate");
    expect(matchKeywordsWordBoundary("seeking approbate of the board", DISTRESS_CONDITION_KEYWORDS)).not.toContain("probate");
  });
  it("'structural' matches but 'infrastructure' does NOT", () => {
    expect(matchKeywordsWordBoundary("structural issue in the garage", DISTRESS_CONDITION_KEYWORDS)).toContain("structural");
    expect(matchKeywordsWordBoundary("near new infrastructure and parks", DISTRESS_CONDITION_KEYWORDS)).not.toContain("structural");
  });
  it("'tlc' matches as a word but not inside another word", () => {
    expect(matchKeywordsWordBoundary("needs tlc throughout", DISTRESS_CONDITION_KEYWORDS)).toContain("tlc");
    expect(matchKeywordsWordBoundary("subtletly decorated", DISTRESS_CONDITION_KEYWORDS)).not.toContain("tlc");
  });
  it("hyphenated keyword 'as-is' matches", () => {
    expect(matchKeywordsWordBoundary("sold as-is, no repairs", DISTRESS_CONDITION_KEYWORDS)).toContain("as-is");
  });
});

describe("keyword lists carry the operator-specified terms", () => {
  it("wholesaler list", () => {
    for (const k of ["no wholesalers", "end users only", "no investors", "non-assignable", "no daisy chain"]) {
      expect(WHOLESALER_EXCLUSION_KEYWORDS).toContain(k);
    }
  });
  it("distress list", () => {
    for (const k of ["as-is", "handyman special", "foundation repair", "motivated seller", "probate", "cash or hard money"]) {
      expect(DISTRESS_CONDITION_KEYWORDS).toContain(k);
    }
  });
  it("'no financing' intentionally excluded from both lists (too ambiguous)", () => {
    expect(WHOLESALER_EXCLUSION_KEYWORDS).not.toContain("no financing");
    expect(DISTRESS_CONDITION_KEYWORDS).not.toContain("no financing");
  });
});
