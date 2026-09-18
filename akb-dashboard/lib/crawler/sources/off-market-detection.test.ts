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
import { detectInactiveMarkers, detectStillActive, buildResolvedResult, classifyVerifiedListing } from "./firecrawl";

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

  // ── REPRODUCTION — 2026-09-17 Dayton triple-sold incident (round 2) ────
  // Three agents (4900 Genesee Ave, 3467 Zephyr Dr, 816 N Gettysburg Ave —
  // the last one SIX WEEKS after it sold) were texted first-touch offers on
  // houses freshness-reverify had just re-stamped Live_Status=Active. The
  // real Redfin page for 816 N Gettysburg Ave (its Verification_URL) was
  // fetched to confirm the actual shape: the subject's own status region is
  // a BARE line — "SOLD AUG 16, 2026" then "Sold" — never a sentence naming
  // "this home". The subject-named markers alone (round 1 of this fix)
  // would NOT have caught this page. Fixed with line-anchored bare-status
  // detection (detectBareStatusLines) instead: the ENTIRE trimmed line must
  // read as just the status, so prose merely mentioning a sale ("since sold
  // in August 2026") still cannot match, and a NEIGHBOR's identical bare
  // line ("SOLD JUN 12, 2026" under "Recently sold homes") is kept out by
  // scopeStatusText's comps stripping — not by the anchor itself.

  // (a) The real Gettysburg shape, full pipeline (buildResolvedResult +
  // classifyVerifiedListing — the same path the reverify pass and pre-send
  // probe both call). Must reject firecrawl_inactive.
  // ROLLED BACK 2026-09-18: bare status-line detection is not wired into production
  // (3 of 4 sampled Redfin marks were live listings; comps text leaked past scoping).
  // Re-enable when the detector is rebuilt against real Firecrawl markdown.
  it.skip("816 N Gettysburg Ave — real Redfin shape rejects firecrawl_inactive", () => {
    const md = [
      "# 816 N Gettysburg Ave, Dayton, OH 45417",
      "SOLD AUG 16, 2026",
      "Sold",
      "since sold in August 2026",
      "3 bed, 1 bath, 890 sqft",
      "Recently sold homes",
      "SOLD JUN 12, 2026",
      "SOLD JUN 8, 2026",
      "Sold",
      "Pending",
      "Sold",
    ].join("\n");
    const fc = buildResolvedResult(md, "https://www.redfin.com/OH/Dayton/816-N-Gettysburg-Ave-45417/home/75965067", "816 N Gettysburg Ave", 1, false);
    expect(fc.resolved).toBe(true);
    expect(fc.matchedInactiveMarkers).toEqual(expect.arrayContaining(["status-line: sold aug 16, 2026", "status-line: sold"]));
    expect(fc.stillActive).toBe(false);
    expect(classifyVerifiedListing(fc)).toEqual({ outcome: "reject", reason: "firecrawl_inactive" });
  });

  // (b) Zillow-shape: a "Sold" chip line followed by a "Sold on MM/DD/YY"
  // chip line — the other common portal rendering.
  // ROLLED BACK 2026-09-18: bare status-line detection is not wired into production
  // (3 of 4 sampled Redfin marks were live listings; comps text leaked past scoping).
  // Re-enable when the detector is rebuilt against real Firecrawl markdown.
  it.skip("Zillow shape: 'Sold' then 'Sold on 08/29/26' chip lines are detected", () => {
    const md = "# 1 Test St, City, ST 00000\nSold\nSold on 08/29/26\n3 bed 1 bath.";
    expect(detectStillActive(md)).toBe(false);
  });

  // (c) NEGATIVE: an ACTIVE listing whose own status region has no bare
  // status line, even though its Sale & Tax History has "Sold" table rows
  // and its Recently-sold comps have bare "SOLD JUN 12, 2026" lines — both
  // sections must be scoped away before the anchor ever sees them.
  it("NEGATIVE: an active listing's history + comps 'Sold' lines don't leak into its own status", () => {
    const md = [
      "# 1 Test St, City, ST 00000",
      "For sale — $199,000. 3 bed, 2 bath.",
      "Active on market, 12 days.",
      "## Sale & Tax History",
      "| 3/04/2018 | Sold | $92,000 |",
      "## Recently sold homes",
      "SOLD JUN 12, 2026",
      "SOLD JUN 8, 2026",
    ].join("\n");
    expect(detectStillActive(md)).toBe(true);
  });

  // (d) NEGATIVE: Redfin's own trademark boilerplate names "pending" inside
  // a sentence — must not read as a bare status chip.
  it("NEGATIVE: Redfin's USPTO trademark line does not contain a bare status", () => {
    const md =
      "Redfin and all Redfin variants are trademarks of Redfin Corporation, registered or pending in the USPTO.";
    expect(detectStillActive(md)).toBe(true);
  });

  // ── RESIDUAL GAP — deliberately still failing-open, pinned here so it is
  // visible rather than forgotten. Needs an operator ruling because closing
  // it trades send VOLUME for send ACCURACY.

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
