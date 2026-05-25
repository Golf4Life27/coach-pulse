// Ship 2 — RentCast intake adapter pure tests.

import { describe, it, expect } from "vitest";
import {
  buildListingsUrl,
  detectPriceReduction,
  cityFromFormatted,
  mapListingToCandidate,
  mapListingsResponse,
} from "./rentcast";

describe("buildListingsUrl", () => {
  it("targets /listings/sale with SFR + Active + limit 500", () => {
    const url = buildListingsUrl("78210");
    expect(url).toContain("api.rentcast.io/v1/listings/sale");
    expect(url).toContain("zipCode=78210");
    expect(url).toContain("propertyType=Single+Family");
    expect(url).toContain("status=Active");
    expect(url).toContain("limit=500");
  });
});

describe("detectPriceReduction", () => {
  it("true when history array shows a drop", () => {
    expect(detectPriceReduction([{ price: 200000 }, { price: 180000 }], 180000)).toBe(true);
  });
  it("true when history object shows a drop", () => {
    expect(
      detectPriceReduction({ "2026-01": { price: 200000 }, "2026-03": { price: 175000 } }, 175000),
    ).toBe(true);
  });
  it("true when first historical price exceeds current", () => {
    expect(detectPriceReduction([{ price: 210000 }], 190000)).toBe(true);
  });
  it("false when prices flat/rising", () => {
    expect(detectPriceReduction([{ price: 180000 }, { price: 190000 }], 190000)).toBe(false);
  });
  it("false when no history", () => {
    expect(detectPriceReduction(undefined, 190000)).toBe(false);
    expect(detectPriceReduction([], 190000)).toBe(false);
  });
});

describe("cityFromFormatted", () => {
  it("parses city from a 3-part formatted address", () => {
    expect(cityFromFormatted("123 Main St, San Antonio, TX 78210")).toBe("San Antonio");
  });
  it("null on short/absent", () => {
    expect(cityFromFormatted("123 Main St")).toBeNull();
    expect(cityFromFormatted(null)).toBeNull();
  });
});

describe("mapListingToCandidate", () => {
  const raw = {
    id: "abc-123",
    formattedAddress: "123 Main St, San Antonio, TX 78210",
    state: "TX",
    zipCode: "78210",
    propertyType: "Single Family",
    bedrooms: 3,
    bathrooms: 2,
    squareFootage: 1400,
    status: "Active",
    price: 185000,
    listedDate: "2026-05-01T00:00:00Z",
    daysOnMarket: 24,
    mlsName: "SABOR",
    mlsNumber: "1700001",
    history: [{ price: 200000 }, { price: 185000 }],
  };

  it("maps real active-listing fields (no listing-data gap)", () => {
    const c = mapListingToCandidate(raw);
    expect(c.sourceId).toBe("rentcast:abc-123");
    expect(c.address).toBe("123 Main St, San Antonio, TX 78210");
    expect(c.city).toBe("San Antonio");
    expect(c.state).toBe("TX");
    expect(c.zip).toBe("78210");
    expect(c.propertyType).toBe("Single Family");
    expect(c.beds).toBe(3);
    expect(c.listPrice).toBe(185000);
    expect(c.listedDate).toBe("2026-05-01T00:00:00Z");
  });

  it("derives distress from price-reduction history", () => {
    expect(mapListingToCandidate(raw).hasDistressSignal).toBe(true);
  });

  it("no distress when no reduction", () => {
    const c = mapListingToCandidate({ ...raw, history: [{ price: 185000 }] });
    expect(c.hasDistressSignal).toBe(false);
  });

  it("falls back to mlsNumber then address for sourceId", () => {
    expect(mapListingToCandidate({ mlsNumber: "99", formattedAddress: "x" }).sourceId).toBe("rentcast:mls:99");
    expect(mapListingToCandidate({ formattedAddress: "5 Oak St" }).sourceId).toBe("rentcast:5 Oak St");
  });

  it("degrades gracefully on sparse object", () => {
    const c = mapListingToCandidate({});
    expect(c.address).toBeNull();
    expect(c.listPrice).toBeNull();
  });
});

describe("mapListingsResponse", () => {
  it("maps a listings array", () => {
    expect(mapListingsResponse([{ id: "1" }, { id: "2" }])).toHaveLength(2);
  });
  it("[] on non-array", () => {
    expect(mapListingsResponse({})).toEqual([]);
    expect(mapListingsResponse(null)).toEqual([]);
  });
});
