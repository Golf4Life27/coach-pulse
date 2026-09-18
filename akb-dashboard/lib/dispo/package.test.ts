// DISPO PACKAGE — composer tests (2026-09-12).
//
// The load-bearing assertion is the banned-vocabulary sweep over
// JSON.stringify of the WHOLE package: this copy gets pasted into Facebook
// groups and Marketplace by a browser mission, where it is public forever and
// nobody reviews it after the fact. A future line that helpfully mentions the
// ARV, the spread, the fee, or a track record AKB does not have fails here
// instead of in a group with 40k members.
//
// Second sweep: printable-ASCII only. These strings reach SMS, where one
// em-dash forces UCS-2 and roughly doubles the billed segments
// (lib/sms/gsm7.ts).

import { describe, it, expect } from "vitest";
import {
  composeDispoPackage,
  DISPO_DISCLOSURE,
  DISPO_DISCLOSURE_SHORT,
  DM_REPLY_MAX,
  MARKETPLACE_DESCRIPTION_MAX,
  MARKETPLACE_TITLE_MAX,
  SMS_MAX_CHARS,
  type DispoPackage,
} from "./package";
import { findBannedCopy } from "./copy-guard";
import type { PublicDealView } from "./public-deal";
import { estimateSmsSegments, findNonGsm7Chars } from "@/lib/sms/gsm7";

const NOW = "2026-09-12T12:00:00.000Z";
const OPTS = { baseUrl: "https://coach-pulse-ten.vercel.app", nowIso: NOW };

/** Every field populated — the leak fixture. */
function fullView(over: Partial<PublicDealView> = {}): PublicDealView {
  return {
    recordId: "recDEAL0000000001",
    city: "San Antonio",
    state: "TX",
    zip: "78210",
    beds: 3,
    baths: 2,
    sqft: 1412,
    yearBuilt: 1968,
    propertyType: "Single Family",
    assignmentPrice: 132_500,
    optionDeadline: "2026-09-20",
    closeDate: "2026-09-29",
    photos: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
    headline: "Contract assignment: San Antonio, TX 78210",
    ...over,
  };
}

/** Nothing optional populated — the "never print the word null" fixture. */
function bareView(): PublicDealView {
  return {
    recordId: "recDEAL0000000002",
    city: "Birmingham",
    state: "AL",
    zip: "35204",
    beds: null,
    baths: null,
    sqft: null,
    yearBuilt: null,
    propertyType: null,
    assignmentPrice: null,
    optionDeadline: null,
    closeDate: null,
    photos: [],
    headline: "Contract assignment: Birmingham, AL 35204",
  };
}

/** An MLS-sourced deal — same shape as fullView, named to make explicit that
 *  the composer must never distinguish MLS-sourced from any other deal in
 *  its buyer-facing copy (operator ruling, Spine recydfR9ZsDNSe0Lr). */
function mlsView(over: Partial<PublicDealView> = {}): PublicDealView {
  return fullView(over);
}

function allStrings(pkg: DispoPackage): string[] {
  return [
    pkg.dealUrl,
    pkg.disclosure,
    pkg.onePager.title,
    ...pkg.onePager.facts.flatMap((f) => [f.label, f.value]),
    ...pkg.onePager.body,
    pkg.posts.facebookGroup,
    pkg.posts.marketplaceTitle,
    pkg.posts.marketplaceDescription,
    pkg.posts.dmReply,
    pkg.posts.sms,
  ];
}

function postBlocks(pkg: DispoPackage): string[] {
  return [
    pkg.posts.facebookGroup,
    pkg.posts.marketplaceDescription,
    pkg.posts.dmReply,
    pkg.posts.sms,
  ];
}

// The vocabulary that must never reach a buyer-facing surface. "fee" and
// "spread" are our margin; "arv"/"rehab" are our underwriting; "seller" and
// "agent" are the other side of the table; "track record"/"guaranteed" are
// claims AKB cannot make (zero closings to date — see lib/standing-answers.ts).
const BANNED = [
  "arv",
  "rehab",
  "repair estimate",
  "spread",
  "assignment fee",
  "fee",
  "contract price",
  "list price",
  "listed at",
  "mls",
  "seller",
  "agent",
  "wholesale deal",
  "track record",
  "we've done",
  "we have done",
  "guaranteed",
];

describe("composeDispoPackage — leak posture", () => {
  it("never contains the banned vocabulary anywhere in the serialized package", () => {
    const serialized = JSON.stringify(composeDispoPackage(fullView(), OPTS)).toLowerCase();
    for (const word of BANNED) {
      expect(serialized, `banned word "${word}" reached the package`).not.toContain(word);
    }
  });

  it("carries only one money figure: the assignment price", () => {
    const pkg = composeDispoPackage(fullView(), OPTS);
    const serialized = JSON.stringify(pkg);
    const dollarAmounts = serialized.match(/\$[\d,]+/g) ?? [];
    expect(new Set(dollarAmounts)).toEqual(new Set(["$132,500"]));
    expect(pkg.onePager.body.join("\n")).toContain("Price: $132,500");
  });

  it("is printable ASCII only — no em dash, en dash, or curly quote", () => {
    for (const s of allStrings(composeDispoPackage(fullView(), OPTS))) {
      // em dash, en dash, figure dash, curly single/double quotes, ellipsis.
      expect(s).not.toMatch(/[—–‒‘’“”…]/);
      expect(s).not.toMatch(/[^\x20-\x7E\n]/);
    }
  });
});

describe("composeDispoPackage — the disclosure is not optional", () => {
  it("puts the short disclosure at the end of every post", () => {
    const pkg = composeDispoPackage(fullView(), OPTS);
    for (const post of postBlocks(pkg)) {
      expect(post.endsWith(DISPO_DISCLOSURE_SHORT)).toBe(true);
    }
  });

  it("ends the one-pager body with the full disclosure", () => {
    const pkg = composeDispoPackage(fullView(), OPTS);
    expect(pkg.onePager.body[pkg.onePager.body.length - 1]).toBe(DISPO_DISCLOSURE);
    expect(pkg.disclosure).toBe(DISPO_DISCLOSURE);
  });

  it("still discloses on the bare deal, where there is almost no other copy", () => {
    const pkg = composeDispoPackage(bareView(), OPTS);
    expect(pkg.onePager.body[pkg.onePager.body.length - 1]).toBe(DISPO_DISCLOSURE);
    for (const post of postBlocks(pkg)) {
      expect(post.endsWith(DISPO_DISCLOSURE_SHORT)).toBe(true);
    }
  });
});

describe("composeDispoPackage — missing fields render as absent, never as 'null'", () => {
  it("prints no null, undefined, or price line for a bare deal", () => {
    const serialized = JSON.stringify(composeDispoPackage(bareView(), OPTS));
    expect(serialized.toLowerCase()).not.toContain("null");
    expect(serialized.toLowerCase()).not.toContain("undefined");
    expect(serialized).not.toContain("Price:");
    expect(serialized).not.toContain("$");
  });

  it("keeps the area, the link, and the proof-of-funds ask even with no facts", () => {
    const pkg = composeDispoPackage(bareView(), OPTS);
    expect(pkg.posts.facebookGroup).toContain("Contract assignment: Birmingham, AL 35204");
    expect(pkg.posts.facebookGroup).toContain(pkg.dealUrl);
    expect(pkg.posts.facebookGroup.toLowerCase()).toContain("proof of funds");
    expect(pkg.onePager.facts).toEqual([]);
  });

  it("drops an inspection window that has already closed", () => {
    const live = composeDispoPackage(fullView(), OPTS);
    expect(live.posts.facebookGroup).toContain("Inspection period ends Sep 20, 2026");
    const stale = composeDispoPackage(fullView({ optionDeadline: "2026-09-01" }), OPTS);
    expect(stale.posts.facebookGroup.toLowerCase()).not.toContain("inspection period ends");
  });

  it("renders present facts and omits absent ones", () => {
    const pkg = composeDispoPackage(fullView({ yearBuilt: null, propertyType: null }), OPTS);
    expect(pkg.posts.facebookGroup).toContain("3 bed / 2 bath, 1,412 sq ft");
    expect(pkg.posts.facebookGroup).not.toContain("built");
    expect(pkg.onePager.facts.map((f) => f.label)).toEqual([
      "Beds",
      "Baths",
      "Sq Ft",
      "Price",
      "Close By",
      "Inspection Ends",
    ]);
  });
});

describe("composeDispoPackage — channel limits", () => {
  it("keeps the SMS template inside 300 GSM-7 characters", () => {
    for (const view of [fullView(), bareView(), fullView({ city: "Fredericksburg-on-the-Extension-Boulevard" })]) {
      const { sms } = composeDispoPackage(view, OPTS).posts;
      expect(sms.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
      expect(findNonGsm7Chars(sms)).toEqual([]);
      expect(estimateSmsSegments(sms).encoding).toBe("gsm7");
      expect(sms.endsWith(DISPO_DISCLOSURE_SHORT)).toBe(true);
    }
  });

  it("keeps the Marketplace title, description, and DM reply inside their caps", () => {
    const pkg = composeDispoPackage(fullView(), OPTS);
    expect(pkg.posts.marketplaceTitle.length).toBeLessThanOrEqual(MARKETPLACE_TITLE_MAX);
    expect(pkg.posts.marketplaceDescription.length).toBeLessThanOrEqual(MARKETPLACE_DESCRIPTION_MAX);
    expect(pkg.posts.dmReply.length).toBeLessThanOrEqual(DM_REPLY_MAX);
    expect(pkg.posts.marketplaceTitle).toBe("Contract assignment: San Antonio, TX - 3bd/2ba - $132,500");
  });

  it("keeps the STREET address out of every public block, and on the one-pager only when the operator supplies it", () => {
    // A full address in a public group lets a buyer go around us to the
    // listing agent, and the copy promises the address for proof of funds.
    // The street never comes from the view (it has no address field) — it
    // is only ever the operator-authenticated print sheet's own opt-in.
    const withStreet = composeDispoPackage(fullView(), { ...OPTS, onePagerAddress: "513 Lamar St" });
    for (const block of [
      withStreet.posts.facebookGroup,
      withStreet.posts.marketplaceTitle,
      withStreet.posts.marketplaceDescription,
      withStreet.posts.dmReply,
      withStreet.posts.sms,
    ]) {
      expect(block).not.toContain("513 Lamar");
      expect(block.toLowerCase()).not.toContain("off-market");
    }
    expect(withStreet.onePager.title).toBe("Contract assignment: 513 Lamar St, San Antonio, TX 78210");

    // Listing.address is often already the full "street, city, ST zip" line;
    // the title must not print the city twice.
    const withFullLine = composeDispoPackage(fullView(), {
      ...OPTS,
      onePagerAddress: "513 Lamar St, San Antonio, TX 78210",
    });
    expect(withFullLine.onePager.title).toBe("Contract assignment: 513 Lamar St, San Antonio, TX 78210");

    const withoutStreet = composeDispoPackage(fullView(), OPTS);
    const serialized = JSON.stringify(withoutStreet);
    expect(serialized).not.toContain("513 Lamar");
  });

  it("writes a Facebook group post of 6-10 short lines with no more than 3 hashtags and no emoji", () => {
    for (const view of [fullView(), bareView()]) {
      const post = composeDispoPackage(view, OPTS).posts.facebookGroup;
      const lines = post.split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(6);
      expect(lines.length).toBeLessThanOrEqual(10);
      expect((post.match(/#/g) ?? []).length).toBeLessThanOrEqual(3);
      expect(post).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });

  it("points every call to action at the public deal page", () => {
    const pkg = composeDispoPackage(fullView(), OPTS);
    expect(pkg.dealUrl).toBe("https://coach-pulse-ten.vercel.app/d/recDEAL0000000001");
    for (const post of postBlocks(pkg)) {
      expect(post).toContain(pkg.dealUrl);
    }
  });

  it("passes the buyer-safe photos through untouched", () => {
    expect(composeDispoPackage(fullView(), OPTS).photos).toEqual([
      "https://cdn.example.com/a.jpg",
      "https://cdn.example.com/b.jpg",
    ]);
  });

  it('says "Details and photos" only when there are photos, and never says "photos" otherwise', () => {
    const withPhotos = composeDispoPackage(fullView(), OPTS);
    expect(withPhotos.posts.facebookGroup).toContain(`Details and photos: ${withPhotos.dealUrl}`);
    expect(withPhotos.posts.dmReply).toContain(`Photos and details: ${withPhotos.dealUrl}`);
    expect(withPhotos.posts.sms).toContain(`Photos: ${withPhotos.dealUrl}`);

    const noPhotos = composeDispoPackage(bareView(), OPTS);
    for (const s of [...postBlocks(noPhotos), noPhotos.onePager.body.join("\n"), noPhotos.onePager.title]) {
      expect(s.toLowerCase()).not.toContain("photos");
    }
    expect(noPhotos.posts.facebookGroup).toContain(`Details: ${noPhotos.dealUrl}`);
    expect(noPhotos.posts.dmReply).toContain(`Details: ${noPhotos.dealUrl}`);
    expect(noPhotos.posts.sms).toContain(`Details: ${noPhotos.dealUrl}`);
  });
});

describe("composeDispoPackage — every post still ends with the disclosure after guarding", () => {
  it("ends every post with DISPO_DISCLOSURE_SHORT and the one-pager body with DISPO_DISCLOSURE", () => {
    for (const view of [fullView(), bareView(), mlsView()]) {
      const pkg = composeDispoPackage(view, OPTS);
      for (const post of postBlocks(pkg)) {
        expect(post.endsWith(DISPO_DISCLOSURE_SHORT)).toBe(true);
      }
      expect(pkg.onePager.body[pkg.onePager.body.length - 1]).toBe(DISPO_DISCLOSURE);
    }
  });
});

describe("composeDispoPackage — MLS-sourced deals get identical, clean copy", () => {
  it("produces no banned phrase in any string for an MLS-sourced fixture", () => {
    const pkg = composeDispoPackage(mlsView(), OPTS);
    for (const s of allStrings(pkg)) {
      expect(findBannedCopy(s)).toEqual([]);
    }
  });
});
