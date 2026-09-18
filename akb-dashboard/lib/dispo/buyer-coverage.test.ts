// @agent: scout — buyer-coverage gate tests (operator ruling 2026-09-18,
// Spine recnmCDflZ43MEsDp).

import { describe, it, expect } from "vitest";
import { assessBuyerCoverage, buyerCoverageItem } from "./buyer-coverage";
import { buildBuyerShortlist, type ShortlistSubject } from "./buyer-shortlist";
import type { Buyer } from "@/lib/types";

const NOW = new Date("2026-09-18T12:00:00Z");

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

const birmingham: ShortlistSubject = {
  recordId: "recDEAL000000001",
  address: "100 Main St, Birmingham, AL 35203",
  zip: "35203",
  state: "AL",
  city: "Birmingham",
  price: 60_000,
};

describe("assessBuyerCoverage", () => {
  it("is 'none' when nobody on the ranked list is in the area", () => {
    const r = buildBuyerShortlist({
      subject: birmingham,
      now: NOW,
      buyers: [buyer({ buyerName: "Elsewhere", preferredStates: "MI" })],
    });
    const c = assessBuyerCoverage(r);
    expect(c.level).toBe("none");
    expect(c.geoBuyers).toBe(0);
    expect(c.fundedBuyers).toBe(0);
    expect(c.reason).toMatch(/No buyers on file/);
    expect(c.reason).toMatch(/35203/);
  });

  it("is 'thin' when there are area buyers but none with usable proof of funds", () => {
    const r = buildBuyerShortlist({
      subject: birmingham,
      now: NOW,
      buyers: [
        buyer({ id: "r1", buyerName: "State Buyer", preferredStates: "AL" }),
        buyer({ id: "r2", buyerName: "Zip Buyer", preferredZipCodes: "35203", buyerEmail: "z@x.com" }),
      ],
    });
    const c = assessBuyerCoverage(r);
    expect(c.level).toBe("thin");
    expect(c.geoBuyers).toBe(2);
    expect(c.fundedBuyers).toBe(0);
    expect(c.emailable).toBe(1);
    expect(c.reason).toMatch(/2 buyers in the area, none with proof of funds/);
  });

  it("is 'ok' when at least one area buyer has usable proof of funds", () => {
    const r = buildBuyerShortlist({
      subject: birmingham,
      now: NOW,
      buyers: [
        buyer({ id: "r1", buyerName: "Funded Buyer", preferredStates: "AL", proofOfFundsOnFile: true }),
      ],
    });
    const c = assessBuyerCoverage(r);
    expect(c.level).toBe("ok");
    expect(c.fundedBuyers).toBe(1);
  });

  it("treats an expired proof of funds as not funded", () => {
    const r = buildBuyerShortlist({
      subject: birmingham,
      now: NOW,
      buyers: [
        buyer({
          id: "r1", buyerName: "Expired POF", preferredStates: "AL",
          proofOfFundsOnFile: true, pofExpiryDate: "2020-01-01",
        }),
      ],
    });
    const c = assessBuyerCoverage(r);
    expect(c.level).toBe("thin");
  });

  it("does not count a buyer screened out by their own stated area (no_match)", () => {
    const r = buildBuyerShortlist({
      subject: birmingham,
      now: NOW,
      buyers: [buyer({ buyerName: "Michigan Only", preferredStates: "MI" })],
    });
    const c = assessBuyerCoverage(r);
    expect(c.geoBuyers).toBe(0);
    expect(c.level).toBe("none");
  });

  it("does not count a buyer with no geography at all (unscreened)", () => {
    const r = buildBuyerShortlist({
      subject: birmingham,
      now: NOW,
      buyers: [buyer({ buyerName: "Blank Profile" })],
    });
    const c = assessBuyerCoverage(r);
    expect(c.geoBuyers).toBe(0);
    expect(c.level).toBe("none");
  });

  it("counts an out-of-price-box buyer as geo coverage (outsideStatedBox rows are still ranked)", () => {
    const r = buildBuyerShortlist({
      subject: birmingham,
      now: NOW,
      buyers: [
        buyer({ buyerName: "Small Box", preferredZipCodes: "35203", maxPrice: 10_000, proofOfFundsOnFile: true }),
      ],
    });
    const c = assessBuyerCoverage(r);
    expect(c.geoBuyers).toBe(1);
    expect(c.fundedBuyers).toBe(1);
    expect(c.level).toBe("ok");
  });
});

describe("buyerCoverageItem", () => {
  it("returns null when coverage is 'ok'", () => {
    const item = buyerCoverageItem({
      recordId: "recDEAL000000001",
      address: "100 Main St",
      city: "Birmingham",
      state: "AL",
      coverage: { level: "ok", geoBuyers: 3, fundedBuyers: 1, emailable: 2, reason: "1 funded buyer in the area." },
      nowIso: NOW.toISOString(),
    });
    expect(item).toBeNull();
  });

  it("builds a HOLD card for 'none' with a 24h implied deadline", () => {
    const nowIso = NOW.toISOString();
    const item = buyerCoverageItem({
      recordId: "recDEAL000000001",
      address: "100 Main St",
      city: "Birmingham",
      state: "AL",
      coverage: { level: "none", geoBuyers: 0, fundedBuyers: 0, emailable: 0, reason: "No buyers on file for 35203." },
      nowIso,
    });
    expect(item).not.toBeNull();
    expect(item!.type).toBe("2C");
    expect(item!.title).toBe("HOLD: no funded buyers in Birmingham, AL - do not sign until dispo has a buyer");
    expect(item!.reasoning).toMatch(/No buyers on file for 35203\. Grow the list or price to a buyer that exists before EMD goes hard\./);
    expect(item!.href).toBe("/pipeline/recDEAL000000001");
    expect(item!.recordId).toBe("recDEAL000000001");
    expect(item!.actions).toEqual([{ kind: "open", href: "/pipeline/recDEAL000000001", label: "See buyers" }]);
    expect(item!.deadlineImplied).toBe(true);
    expect(Date.parse(item!.deadlineAt!)).toBe(Date.parse(nowIso) + 24 * 3_600_000);
  });

  it("builds a HOLD card for 'thin' coverage too", () => {
    const item = buyerCoverageItem({
      recordId: "recDEAL000000002",
      address: "200 Elm St",
      city: "Memphis",
      state: "TN",
      coverage: { level: "thin", geoBuyers: 2, fundedBuyers: 0, emailable: 1, reason: "2 buyers in the area, none with proof of funds on file." },
      nowIso: NOW.toISOString(),
    });
    expect(item).not.toBeNull();
    expect(item!.title).toMatch(/^HOLD: no funded buyers in Memphis, TN/);
  });

  it("is ASCII-only", () => {
    const item = buyerCoverageItem({
      recordId: "recDEAL000000003",
      address: null,
      city: "Detroit",
      state: "MI",
      coverage: { level: "none", geoBuyers: 0, fundedBuyers: 0, emailable: 0, reason: "No buyers on file for Detroit, MI." },
      nowIso: NOW.toISOString(),
    });
    const text = `${item!.title} ${item!.reasoning}`;
    expect(/^[\x00-\x7F]*$/.test(text)).toBe(true);
  });
});
