import { describe, it, expect } from "vitest";
import { haversineMiles, newestRecordedSale, mapPropertyRecordToComp } from "./rentcast";

describe("haversineMiles", () => {
  it("zero distance for identical points", () => {
    expect(haversineMiles(33.7, -84.4, 33.7, -84.4)).toBe(0);
  });
  it("~0.5mi is ~0.5mi (Atlanta latitude)", () => {
    // 0.00725 degrees latitude ≈ 0.50 miles.
    const d = haversineMiles(33.7, -84.4, 33.70725, -84.4);
    expect(d).toBeGreaterThan(0.45);
    expect(d).toBeLessThan(0.55);
  });
});

describe("newestRecordedSale — deed data only", () => {
  it("prefers top-level lastSalePrice/lastSaleDate", () => {
    expect(
      newestRecordedSale({ lastSalePrice: 214_900, lastSaleDate: "2020-08-14T00:00:00.000Z" }),
    ).toEqual({ price: 214_900, date: "2020-08-14T00:00:00.000Z" });
  });

  it("falls back to the history map and picks the NEWEST Sale event", () => {
    const rec = {
      history: {
        "2019-06-11": { event: "Sale", price: 90_000, date: "2019-06-11T00:00:00.000Z" },
        "2026-03-02": { event: "Sale", price: 187_500, date: "2026-03-02T00:00:00.000Z" },
        "2026-05-01": { event: "Listing", price: 219_000, date: "2026-05-01T00:00:00.000Z" },
      },
    };
    expect(newestRecordedSale(rec)).toEqual({ price: 187_500, date: "2026-03-02T00:00:00.000Z" });
  });

  it("a parcel with no sale history is NOT a comp — null, never an ask", () => {
    expect(newestRecordedSale({})).toBeNull();
    expect(newestRecordedSale({ lastSalePrice: 0, lastSaleDate: "2026-01-01" })).toBeNull();
    expect(
      newestRecordedSale({ history: { "2026-05-01": { event: "Listing", price: 219_000, date: "2026-05-01" } } }),
    ).toBeNull();
  });
});

describe("mapPropertyRecordToComp", () => {
  const rec = {
    formattedAddress: "1097 Fortress Ave SW, Atlanta, GA 30315",
    latitude: 33.70725,
    longitude: -84.4,
    squareFootage: 1_293,
    bedrooms: 2,
    bathrooms: 2,
    yearBuilt: 1930,
    lastSalePrice: 214_900,
    lastSaleDate: "2020-08-14T00:00:00.000Z",
  };

  it("maps a deed sale to a comp: price IS the sale price, saleDate IS the deed date", () => {
    const c = mapPropertyRecordToComp(rec, 33.7, -84.4);
    expect(c).not.toBeNull();
    // The Fortress truth: $214,900 recorded in 2020 — never the $267,500 ask.
    expect(c!.price).toBe(214_900);
    expect(c!.saleDate).toBe("2020-08-14T00:00:00.000Z");
    expect(c!.distance).toBeGreaterThan(0.45);
    expect(c!.distance).toBeLessThan(0.55);
    expect(c!.removedDate).toBeNull();
    expect(c!.daysOnMarket).toBeNull();
  });

  it("no subject coordinates → distance null (passes the distance filter as unknown)", () => {
    expect(mapPropertyRecordToComp(rec, null, null)!.distance).toBeNull();
  });

  it("a sale-less parcel maps to nothing", () => {
    expect(mapPropertyRecordToComp({ formattedAddress: "parcel", latitude: 33.7, longitude: -84.4 }, 33.7, -84.4)).toBeNull();
  });
});
