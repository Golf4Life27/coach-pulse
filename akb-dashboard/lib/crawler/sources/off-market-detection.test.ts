// REPRODUCTION — 8203 Brace St, Detroit (2026-08-04 incident).
//
// The system texted agent Jose Diaz a $35,250 cash offer on a property that
// was not on the market. Every gate passed, including the pre-send Firecrawl
// probe, which reported the listing ACTIVE.
//
// The pre-send probe's entire "is this still for sale?" test is
// `stillActive: inactiveMarkers.length === 0` over a three-phrase blocklist.
// These cases feed it the wording the major portals ACTUALLY use for an
// off-market home. Every one of them is a house nobody can buy.

import { describe, it, expect } from "vitest";
import { detectInactiveMarkers, detectStillActive } from "./firecrawl";

// Status-region text as the portals actually render it for a home that is
// no longer for sale. None of these contain the literal strings
// "no longer available", "listing removed", or "no longer on the market".
const OFF_MARKET_PAGES: Array<{ portal: string; text: string }> = [
  { portal: "zillow-off-market", text: "Off market\nZestimate: $92,400\nThis home is not currently listed for sale." },
  { portal: "redfin-sold", text: "SOLD\nThis home last sold for $61,000 on May 12, 2026." },
  { portal: "realtor-off-market", text: "Off Market\nThis property is off market.\nTax history" },
  { portal: "delisted", text: "Status: Delisted\nRemoved from market on 06/02/2026" },
];

describe("REPRO 8203 Brace — off-market pages are classified ACTIVE", () => {
  for (const { portal, text } of OFF_MARKET_PAGES) {
    it(`[${portal}] a house nobody can buy must not read as still-active`, () => {
      expect(detectInactiveMarkers(text).length).toBeGreaterThan(0);
      expect(detectStillActive(text)).toBe(false);
    });
  }

  it("a genuinely active listing still reads active (no over-correction)", () => {
    const active =
      "For sale\n$89,000\n3 bd | 1 ba | 1,040 sqft\nActive · 74 days on Zillow\nPrice history\n05/22/2026 Listed for sale $89,000";
    expect(detectStillActive(active)).toBe(true);
  });

  it("the original three markers keep working", () => {
    expect(detectStillActive("This listing is no longer available")).toBe(false);
    expect(detectStillActive("Listing removed by agent")).toBe(false);
    expect(detectStillActive("The home is no longer on the market")).toBe(false);
  });

  // ── RESIDUAL GAPS — deliberately still failing-open, pinned here so they
  // are visible rather than forgotten. Both need an operator ruling because
  // closing them trades send VOLUME for send ACCURACY.

  // GAP 1: a bare "Sold" / "Off market" banner with no subject-scoped
  // sentence. Bare "off market" and "sold on" were REMOVED on 2026-05-26
  // because a full-page substring scan false-flagged live distress listings
  // from nearby-homes boilerplate (3719 W Houston). scopeStatusText now
  // strips comps + history, which is what made that exclusion stale — but
  // COMPS_HEADERS does not yet match a section titled "Off-market homes
  // nearby", so re-adding the bare phrases could reopen that regression.
  // Fix = extend COMPS_HEADERS first, then re-add. Not done here.
  it("GAP: a bare Sold banner is still not detected", () => {
    expect(detectStillActive("Sold\nSold on 05/12/2026 for $61,000")).toBe(true);
  });

  // GAP 2: the structural defect. `stillActive` is the ABSENCE of a marker,
  // so empty / truncated / unresolved page text reads as ACTIVE. This is a
  // blocklist where INVARIANTS §2 mandates an allowlist ("hold-and-ask on an
  // un-corroborated number, not send-and-hope") and INVARIANTS §1 mandates
  // not_yet_evaluated over a guess. Flipping it to fail-closed would hold
  // every send whose page did not positively confirm "for sale" — correct by
  // doctrine, but it could dark a large share of outreach, so it is the
  // operator's call, not a debug-session change.
  it("GAP: absence of evidence still reads as active (fail-open)", () => {
    expect(detectStillActive("")).toBe(true);
    expect(detectStillActive(null)).toBe(true);
  });
});
