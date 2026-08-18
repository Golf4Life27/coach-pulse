import { describe, expect, it } from "vitest";
import {
  creativePriority,
  isAbsentee,
  isFreeAndClear,
  parsePropStreamEnrichment,
  pickRentWithEnrichment,
} from "./enrichment";
import { termsPriority } from "./terms-opener";
import type { SellerFinanceOffer } from "./seller-finance";

const offer = (over: Partial<SellerFinanceOffer> = {}): SellerFinanceOffer => ({
  verdict: "sendable_terms",
  price: 95000,
  priceCappedToValue: false,
  downPayment: 9500,
  monthlyPayment: 350,
  termMonths: 245,
  wholesaleFee: 5000,
  closingCosts: 1188,
  totalEntry: 15688,
  entryPct: 0.165,
  buyerMonthlyCashflow: 193,
  buyerCashOnCash: 0.148,
  arvBasisUsed: 135000,
  derivation: "test",
  ...over,
});

const BLOB = '{"oo":false,"loans":0,"eq":83000,"ltv":0,"rent":835,"cash":true,"vac":false,"dec":false,"at":"2026-08-18"}';

describe("parsePropStreamEnrichment", () => {
  it("parses the compact blob written by the 2026-08-18 matcher", () => {
    const e = parsePropStreamEnrichment(BLOB)!;
    expect(e.ownerOccupied).toBe(false);
    expect(e.openLoans).toBe(0);
    expect(e.psRent).toBe(835);
    expect(e.lastCashBuyer).toBe(true);
    expect(e.at).toBe("2026-08-18");
  });

  it("returns null on empty/garbled input — unmatched records must not throw", () => {
    expect(parsePropStreamEnrichment(null)).toBeNull();
    expect(parsePropStreamEnrichment("")).toBeNull();
    expect(parsePropStreamEnrichment("not json")).toBeNull();
  });

  it("treats missing loans as UNKNOWN, never free-and-clear", () => {
    const e = parsePropStreamEnrichment('{"oo":false,"at":"2026-08-18"}');
    expect(isFreeAndClear(e)).toBe(false);
    expect(isAbsentee(e)).toBe(true);
  });
});

describe("creativePriority", () => {
  const fc = parsePropStreamEnrichment(BLOB); // free-and-clear + absentee + cash
  const loans = parsePropStreamEnrichment('{"oo":true,"loans":2,"cash":false,"at":"2026-08-18"}');

  it("free-and-clear absentee beats a mortgaged owner-occupant with a better offer", () => {
    const weak = creativePriority(offer({ priceCappedToValue: true, buyerCashOnCash: 0.12 }), fc);
    const strong = creativePriority(offer({ priceCappedToValue: false, buyerCashOnCash: 0.4 }), loans);
    expect(weak).toBeGreaterThan(strong);
  });

  it("unknown enrichment competes on offer quality alone — never buried below known-bad", () => {
    const unknown = creativePriority(offer(), null);
    const knownBad = creativePriority(offer(), loans);
    expect(unknown).toBe(termsPriority(offer()));
    expect(unknown).toBeGreaterThanOrEqual(knownBad);
  });
});

describe("pickRentWithEnrichment", () => {
  const e = parsePropStreamEnrichment(BLOB); // psRent 835

  it("takes the LOWER of model and PropStream — payments only get safer", () => {
    expect(pickRentWithEnrichment({ rent: 950, basis: "modeled_zip" }, e)).toEqual({
      rent: 835,
      basis: "propstream_min",
    });
    expect(pickRentWithEnrichment({ rent: 700, basis: "modeled_zip" }, e)).toEqual({
      rent: 700,
      basis: "modeled_zip",
    });
  });

  it("uses PropStream alone (0.9 haircut) when the model has nothing", () => {
    expect(pickRentWithEnrichment(null, e)).toEqual({ rent: Math.round(835 * 0.9), basis: "propstream_avm" });
  });

  it("passes the model through untouched with no enrichment, null with neither", () => {
    expect(pickRentWithEnrichment({ rent: 900, basis: "modeled_metro" }, null)).toEqual({
      rent: 900,
      basis: "modeled_metro",
    });
    expect(pickRentWithEnrichment(null, null)).toBeNull();
  });
});
