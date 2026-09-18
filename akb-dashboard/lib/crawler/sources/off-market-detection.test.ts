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
import {
  detectInactiveMarkers,
  detectStillActive,
  detectSubjectStatusChip,
  buildResolvedResult,
  classifyVerifiedListing,
} from "./firecrawl";

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
  // would NOT have caught this page.
  //
  // 2026-09-18 REBUILD: rebuilt against the REAL production Firecrawl
  // markdown captured by GET /api/admin/verify-probe (merged #250), not
  // curl-stripped HTML. detectSubjectStatusChip (firecrawl.ts) reads the
  // FIRST status-chip line, top-down — the subject's own header always
  // renders before any comps card, so it is inherently subject-scoped; no
  // separate "is this a comps section" judgment call is needed. The line
  // sequence below reproduces the real page order (nav rows, then the
  // subject's own "SOLD AUG 16, 2026" / "Sold" chips, then price/facts,
  // then "## About this home", then a later comps "Recently sold homes"
  // block whose own bare "SOLD ..." lines render AFTER the heading and so
  // never count as the subject's chip).
  it("816 N Gettysburg Ave — real Redfin shape rejects firecrawl_inactive", () => {
    const md = [
      "Favorite",
      "",
      "Edit Facts",
      "",
      "Share",
      "",
      "SOLD AUG 16, 2026",
      "",
      "816 N Gettysburg Ave photo",
      "Street View",
      "",
      "Redesign",
      "",
      "14 photos",
      "",
      "Sold on Aug 2026",
      "",
      "$40,000",
      "",
      "2",
      "bd",
      "1 ba",
      "768",
      "sq ft",
      "## About this home",
      "Cozy 2 bedroom home in Dayton, OH.",
      "",
      "Listed by Jennifer Core•eXp Realty",
      "Bought with Test Member•Test Office",
      "Redfin checked: [2 minutes ago](https://www.redfin.com/OH/Dayton/816-N-Gettysburg-Ave-45417/home/75965067)",
      "",
      "## Redfin Estimate",
      "$8,979 since sold in August 2026$2,000 since August",
      "- Recently sold homes",
      "SOLD JUN 12, 2026",
      "SOLD JUN 8, 2026",
    ].join("\n");
    const fc = buildResolvedResult(md, "https://www.redfin.com/OH/Dayton/816-N-Gettysburg-Ave-45417/home/75965067", "816 N Gettysburg Ave", 1, false);
    expect(fc.resolved).toBe(true);
    expect(fc.matchedInactiveMarkers).toEqual(["subject-status: sold aug 16, 2026"]);
    expect(fc.stillActive).toBe(false);
    expect(classifyVerifiedListing(fc)).toEqual({ outcome: "reject", reason: "firecrawl_inactive" });
  });

  // (b) Zillow-shape: a "Sold" chip line followed by a "Sold on MM/DD/YY"
  // chip line — the other common portal rendering. The FIRST chip ("Sold")
  // wins; the second is never even reached.
  it("Zillow shape: 'Sold' then 'Sold on 08/29/26' chip lines are detected", () => {
    const md = "Sold\nSold on 08/29/26\n## About this home\n3 bed 1 bath.";
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

// ── REAL PRODUCTION SHAPE — 5338 E 2nd St, Tucson, AZ (2026-09-18) ─────────
// Captured via GET /api/admin/verify-probe (merged #250) against the real
// Firecrawl markdown for an ACTIVE Redfin listing. Reproduces the actual
// line order: nav rows, hero photos, the subject's own bare "For sale" chip,
// price/facts, "## About this home" (the first heading — containing an
// unstripped "this home last sold for" sentence, the exact substring that
// would false-flag under the OLD full-scan behavior), the listing-agent
// footer, then a LATER comps block whose bare "SOLD ..." chip lines have no
// header this file recognizes and so survive scopeStatusText untouched —
// the precise shape that made the 2026-09-17 detector false-flag 27 active
// listings. The "For sale" chip renders first, so it decides — and its
// "active" verdict must suppress the later "this home last sold for" hit.
const TUCSON_ACTIVE_MD = [
  "Favorite",
  "",
  "Hide",
  "",
  "Share",
  "",
  "5338 E 2nd St, Tucson, AZ 85711 photo 1 of 36",
  "3D Tour",
  "",
  "Street View",
  "",
  "36 photos",
  "",
  "For sale",
  "",
  "$374,000",
  "",
  "Est.$2,335/mo —See my rate",
  "",
  "3",
  "bd",
  "2 ba",
  "1,936",
  "sq ft",
  "## About this home",
  "Charming corner-lot home, sold as-is, priced to sell. This home last sold for $210,000 in 2019.",
  "",
  "Listed by Melissa Rich•Tierra Antigua Realty",
  "Listing updated: Sep 3, 2026 at 01:51pm",
  "Redfin checked: [9 minutes ago](https://www.redfin.com/AZ/Tucson/5338-E-2nd-St-85711/home/60123456)",
  "",
  "912 E Water St",
  "SOLD AUG 31, 2026",
  "$350,000",
  "876 E Copper St",
  "SOLD AUG 29, 2026",
  "$298,000",
].join("\n");

describe("REAL SHAPE — 5338 E 2nd St Tucson (ACTIVE) classifies accept, first chip wins", () => {
  it("stillActive true through buildResolvedResult + classifyVerifiedListing accept path", () => {
    const fc = buildResolvedResult(
      TUCSON_ACTIVE_MD,
      "https://www.redfin.com/AZ/Tucson/5338-E-2nd-St-85711/home/60123456",
      "5338 E 2nd St",
      1,
      false,
    );
    expect(fc.resolved).toBe(true);
    // The "active" verdict suppresses the later "this home last sold for"
    // substring hit — no reject-worthy marker survives.
    expect(fc.matchedInactiveMarkers).toEqual([]);
    expect(fc.stillActive).toBe(true);
    expect(classifyVerifiedListing(fc)).toEqual({ outcome: "accept", outreachStatus: "", acceptBasis: "condition_signal" });
  });

  it("a page with NO chip before the first heading, but a comps 'Sold' chip after it, falls back to substring behavior", () => {
    const md = [
      "Some generic intro copy with no status chip at all.",
      "## About this home",
      "This property is off market.",
    ].join("\n");
    // No chip → detectSubjectStatusChip returns null verdict, and the
    // existing substring INACTIVE_MARKERS scan decides instead.
    expect(fcVerdictOnly(md)).toBe("inactive");
  });
});

function fcVerdictOnly(md: string): "active" | "inactive" {
  const fc = buildResolvedResult(md, null, null, 1, false);
  return fc.stillActive ? "active" : "inactive";
}
