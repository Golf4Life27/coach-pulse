// @agent: scout — manual dispo shortlist tests.
//
// The fixtures mirror shapes that are LIVE in the Buyers table today
// (checked 2026-08-09), not invented ones: two coexisting rating
// vocabularies, ZIP lists written as prose with the operator's own
// confidence wording, and rows carrying nothing but a name and a state.

import { describe, it, expect } from "vitest";
import {
  buildBuyerShortlist,
  normalizeRating,
  parseZips,
  parseStates,
  zipFieldIsUnconfirmed,
  looksLikeTestRecord,
  type ShortlistSubject,
} from "./buyer-shortlist";
import type { Buyer } from "@/lib/types";

const NOW = new Date("2026-08-09T12:00:00Z");

function buyer(over: Partial<Buyer> = {}): Buyer {
  return {
    id: "recBUYER00000001",
    buyerName: "Test Buyer",
    buyerEmail: null,
    buyerStatus: "Active",
    preferredCities: null,
    cashBuyer: false,
    proofOfFundsOnFile: false,
    buyerActiveFlag: true,
    buyerPhone: null,
    companyName: null,
    preferredStates: null,
    preferredZipCodes: null,
    minPrice: null,
    maxPrice: null,
    buyerRating: null,
    lastContactedAt: null,
    pofExpiryDate: null,
    dealsPurchasedLast12Months: null,
    ...over,
  };
}

const memphis: ShortlistSubject = {
  recordId: "recDEAL000000001",
  address: "1234 Example St, Memphis, TN 38116",
  zip: "38116",
  state: "TN",
  city: "Memphis",
  price: 45_000,
};

describe("normalizeRating — two vocabularies are live in the table at once", () => {
  it("reads the bare letters from the March import", () => {
    expect(normalizeRating("A")).toBe("A");
    expect(normalizeRating("B")).toBe("B");
  });

  it("reads the emoji-prefixed vocabulary from the April import", () => {
    expect(normalizeRating("🟢 A - Top Buyer")).toBe("A");
    expect(normalizeRating("🟡 B - Active Buyer")).toBe("B");
    expect(normalizeRating("⚪ C - Cold buyer")).toBe("C");
  });

  it("takes '🟡 B - Workflow contact' at its stated grade", () => {
    expect(normalizeRating("🟡 B - Workflow contact")).toBe("B");
  });

  it("returns null rather than guessing on an unrecognised label", () => {
    expect(normalizeRating("Platinum")).toBeNull();
    expect(normalizeRating(null)).toBeNull();
  });
});

describe("parsing the operator's free-text buy-box fields", () => {
  it("pulls every ZIP out of a prose buy box", () => {
    const raw =
      "Most liquid: 38116, 38118, 38127\n\nFull buy box: 38127 (East of HWY 51), 38128, 38109 (East of HWY 61)";
    expect(parseZips(raw)).toContain("38116");
    expect(parseZips(raw)).toContain("38128");
    expect(parseZips(raw)).toContain("38109");
  });

  it("does not mistake highway numbers or street numbers for ZIPs", () => {
    expect(parseZips("38127 (East of HWY 51)")).toEqual(["38127"]);
    expect(parseZips("no zips here, just HWY 61 and 1234 Main")).toEqual([]);
  });

  it("reads the operator's own confidence wording", () => {
    expect(zipFieldIsUnconfirmed("78245 (unconfirmed — contacted once)")).toBe(true);
    expect(zipFieldIsUnconfirmed("Memphis — 38106 confirmed")).toBe(false);
  });

  it("parses multi-state fields", () => {
    expect(parseStates("TN, MS")).toEqual(["TN", "MS"]);
    expect(parseStates("TX")).toEqual(["TX"]);
  });

  it("flags only the literal test/delete artifacts", () => {
    expect(looksLikeTestRecord("Alex Balog (TEST)")).toBe(true);
    expect(looksLikeTestRecord("[DELETE] duplicate artifact")).toBe(true);
    expect(looksLikeTestRecord("Detroit One Holdings")).toBe(false);
    // A real buyer whose name merely contains the letters must survive.
    expect(looksLikeTestRecord("Testa Property Group")).toBe(false);
  });
});

describe("ranking", () => {
  it("puts a confirmed-ZIP buyer above a state-only buyer", () => {
    const r = buildBuyerShortlist({
      subject: memphis,
      now: NOW,
      buyers: [
        buyer({ id: "recSTATE00000001", buyerName: "State Only", preferredStates: "TN" }),
        buyer({
          id: "recZIP0000000001",
          buyerName: "Zip Match",
          preferredStates: "TN",
          preferredZipCodes: "38116, 38118",
        }),
      ],
    });
    expect(r.ranked[0].name).toBe("Zip Match");
    expect(r.ranked[0].geo).toBe("zip_confirmed");
    expect(r.ranked[1].geo).toBe("state");
  });

  it("ranks an operator-flagged unconfirmed ZIP below a confirmed one but above state-only", () => {
    const r = buildBuyerShortlist({
      subject: { ...memphis, zip: "78245", state: "TX" },
      now: NOW,
      buyers: [
        buyer({ id: "recA", buyerName: "Unconfirmed Zip", preferredStates: "TX", preferredZipCodes: "78245 (unconfirmed — contacted once)" }),
        buyer({ id: "recB", buyerName: "State Only", preferredStates: "TX" }),
        buyer({ id: "recC", buyerName: "Confirmed Zip", preferredStates: "TX", preferredZipCodes: "78245 confirmed — full SA metro" }),
      ],
    });
    expect(r.ranked.map((x) => x.name)).toEqual(["Confirmed Zip", "Unconfirmed Zip", "State Only"]);
  });

  it("keeps a buyer with no geography at all — an empty profile is not a rejection", () => {
    const r = buildBuyerShortlist({
      subject: memphis,
      now: NOW,
      buyers: [buyer({ buyerName: "Blank Profile", cashBuyer: true })],
    });
    expect(r.ranked).toHaveLength(1);
    expect(r.ranked[0].geo).toBe("none");
    expect(r.ranked[0].reasons).toContain("No geography on file — unscreened");
  });

  it("keeps an over-max buyer in `ranked` but out of `top`", () => {
    const r = buildBuyerShortlist({
      subject: memphis, // $45,000
      now: NOW,
      buyers: [
        buyer({ id: "recOVER", buyerName: "Small Box", preferredZipCodes: "38116", maxPrice: 30_000 }),
        buyer({ id: "recFIT", buyerName: "Fits", preferredStates: "TN" }),
      ],
    });
    expect(r.ranked.map((x) => x.name)).toContain("Small Box");
    expect(r.top.map((x) => x.name)).not.toContain("Small Box");
    const over = r.ranked.find((x) => x.name === "Small Box")!;
    expect(over.price).toBe("over_max");
    expect(over.outsideStatedBox).toBe(true);
    expect(over.reasons.join(" ")).toMatch(/Above their stated max of \$30,000/);
  });

  it("treats an expired proof of funds as absent, not as weaker credit", () => {
    const expired = buildBuyerShortlist({
      subject: memphis, now: NOW,
      buyers: [buyer({ proofOfFundsOnFile: true, pofExpiryDate: "2026-01-01" })],
    }).ranked[0];
    const live = buildBuyerShortlist({
      subject: memphis, now: NOW,
      buyers: [buyer({ proofOfFundsOnFile: true, pofExpiryDate: "2026-12-01" })],
    }).ranked[0];
    expect(expired.pofUsable).toBe(false);
    expect(live.pofUsable).toBe(true);
    expect(live.score).toBeGreaterThan(expired.score);
    expect(expired.reasons.join(" ")).toMatch(/EXPIRED/);
  });

  it("drops inactive rows and test artifacts, and says how many it dropped", () => {
    const r = buildBuyerShortlist({
      subject: memphis,
      now: NOW,
      buyers: [
        // Deliberately single-qualifying rows: exclusions are attributed to
        // the first matching reason, so a row that is both a delete artifact
        // and Inactive would make these counts ambiguous.
        buyer({ id: "recX", buyerName: "[DELETE] duplicate artifact" }),
        buyer({ id: "recY", buyerName: "Alex Balog (TEST)" }),
        buyer({ id: "recW", buyerName: "Retired Buyer", buyerStatus: "Inactive" }),
        buyer({ id: "recZ", buyerName: "Real Buyer", preferredStates: "TN" }),
      ],
    });
    expect(r.ranked.map((x) => x.name)).toEqual(["Real Buyer"]);
    expect(r.coverage.excludedTestRecords).toBe(2);
    expect(r.coverage.excludedInactive).toBe(1);
    expect(r.coverage.buyersConsidered).toBe(1);
  });

  it("breaks a score tie toward the buyer you can actually call", () => {
    const r = buildBuyerShortlist({
      subject: memphis,
      now: NOW,
      buyers: [
        buyer({ id: "recNOPHONE", buyerName: "AAA No Phone", preferredStates: "TN" }),
        buyer({ id: "recPHONE", buyerName: "ZZZ Has Phone", preferredStates: "TN", buyerPhone: "901-555-0100" }),
      ],
    });
    expect(r.ranked[0].name).toBe("ZZZ Has Phone");
  });

  it("surfaces recent contact instead of silently reranking on it", () => {
    const r = buildBuyerShortlist({
      subject: memphis,
      now: NOW,
      buyers: [buyer({ preferredStates: "TN", lastContactedAt: "2026-08-06" })],
    });
    expect(r.ranked[0].daysSinceContact).toBe(3);
    expect(r.ranked[0].reasons.join(" ")).toMatch(/Contacted 3d ago/);
  });

  it("degrades to price:unknown rather than guessing when the deal has no price", () => {
    const r = buildBuyerShortlist({
      subject: { ...memphis, price: null },
      now: NOW,
      buyers: [buyer({ preferredStates: "TN", maxPrice: 30_000 })],
    });
    expect(r.ranked[0].price).toBe("unknown");
    expect(r.ranked[0].outsideStatedBox).toBe(false);
  });

  it("reports coverage so a thin list is attributable to the rolodex, not the matcher", () => {
    const r = buildBuyerShortlist({
      subject: memphis,
      now: NOW,
      buyers: [
        buyer({ id: "r1", buyerName: "Zip", preferredZipCodes: "38116", buyerPhone: "901-555-0100" }),
        buyer({ id: "r2", buyerName: "State", preferredStates: "TN" }),
        buyer({ id: "r3", buyerName: "Blank" }),
        buyer({ id: "r4", buyerName: "Elsewhere", preferredStates: "MI" }),
      ],
    });
    expect(r.coverage).toMatchObject({
      buyersConsidered: 4,
      withZipMatch: 1,
      withStateMatch: 1,
      withGeoMismatch: 1, // the MI buyer — screened out by their own box
      withNoGeoData: 1,   // the blank profile — unscreened, still callable
      withPhone: 1,
    });
  });

  it("separates a buyer screened out by their own stated area from one with no area on file", () => {
    const r = buildBuyerShortlist({
      subject: memphis,
      now: NOW,
      buyers: [
        buyer({ id: "recMI", buyerName: "Michigan Only", preferredStates: "MI" }),
        buyer({ id: "recBLANK", buyerName: "Blank Profile" }),
      ],
    });
    const mi = r.ranked.find((x) => x.name === "Michigan Only")!;
    const blank = r.ranked.find((x) => x.name === "Blank Profile")!;
    expect(mi.geo).toBe("no_match");
    expect(blank.geo).toBe("none");
    expect(mi.reasons.join(" ")).toMatch(/Stated area \(MI\) does not include this deal/);
    // A stated "I don't buy there" is worse than saying nothing at all.
    expect(mi.score).toBeLessThan(blank.score);
  });

  it("does not let price/rating points float an out-of-area buyer above the local one", () => {
    // The live 2026-08-09 failure: on a Cleveland deal a Memphis buyer with a
    // fitting price box and an A rating outranked the only Ohio buyer, who had
    // a state match but no price box and a lower grade. Geography has to win.
    const cleveland: ShortlistSubject = {
      recordId: "recDEAL2", address: "2175 W 106th St", zip: "44102",
      state: "OH", city: "Cleveland", price: 49_000,
    };
    const r = buildBuyerShortlist({
      subject: cleveland,
      now: NOW,
      buyers: [
        buyer({
          id: "recFAR", buyerName: "Memphis Buyer", preferredStates: "TN, MS",
          preferredZipCodes: "38116, 38118", maxPrice: 250_000,
          buyerRating: "🟢 A - Top Buyer", cashBuyer: true, buyerPhone: "662-555-0100",
        }),
        buyer({
          id: "recLOCAL", buyerName: "Ohio Buyer", preferredStates: "OH",
          buyerRating: "🟡 B - Active Buyer", cashBuyer: true,
        }),
      ],
    });
    expect(r.ranked[0].name).toBe("Ohio Buyer");
  });

  it("every returned buyer carries at least one plain-language reason", () => {
    const r = buildBuyerShortlist({
      subject: memphis,
      now: NOW,
      buyers: [
        buyer({ id: "r1", preferredZipCodes: "38116", buyerRating: "🟢 A - Top Buyer", cashBuyer: true }),
        buyer({ id: "r2", preferredStates: "MI" }),
      ],
    });
    for (const b of r.ranked) expect(b.reasons.length).toBeGreaterThan(0);
  });
});
