import { describe, it, expect } from "vitest";
import {
  countyDeedSourceFor,
  deedRowToComp,
  cuyahogaFeatureToComp,
  COUNTY_DEED_SOURCES,
  type ParcelRow,
} from "./county-deeds";

const DETROIT = COUNTY_DEED_SOURCES[0];

describe("countyDeedSourceFor — registry routing", () => {
  it("Detroit, MI routes to the county ledger", () => {
    expect(countyDeedSourceFor("Detroit", "MI")?.market).toBe("detroit");
    expect(countyDeedSourceFor("detroit", "mi")?.market).toBe("detroit");
  });

  it("separate assessors and other metros fall through to the vendor path", () => {
    // Highland Park is inside Detroit's borders but a SEPARATE city/assessor.
    expect(countyDeedSourceFor("Highland Park", "MI")).toBeNull();
    expect(countyDeedSourceFor("Atlanta", "GA")).toBeNull();
    expect(countyDeedSourceFor(null, "MI")).toBeNull();
    expect(countyDeedSourceFor("Detroit", null)).toBeNull();
  });

  it("UNPROMOTED sources never route production — benchmark lane only", () => {
    // Cuyahoga ships unpromoted (feed lags ~11 weeks vs Detroit's 3 days;
    // promotion is an operator ruling on benchmark receipts).
    expect(countyDeedSourceFor("Cleveland", "OH")).toBeNull();
    expect(countyDeedSourceFor("Cleveland", "OH", { includeUnpromoted: true })?.market).toBe("cuyahoga");
    expect(countyDeedSourceFor("East Cleveland", "OH", { includeUnpromoted: true })?.market).toBe("cuyahoga");
    // Promoted sources are unaffected by the flag.
    expect(countyDeedSourceFor("Detroit", "MI", { includeUnpromoted: true })?.market).toBe("detroit");
    // Outside the registry stays outside.
    expect(countyDeedSourceFor("Columbus", "OH", { includeUnpromoted: true })).toBeNull();
  });
});

describe("deedRowToComp — the courthouse row becomes engine fuel", () => {
  const parcels = new Map<string, ParcelRow>([
    ["22063243.", { parcel_id: "22063243.", total_floor_area: 1_100, year_built: 1941 }],
  ]);

  it("maps a real arm's-length deed: price IS the recorded price, saleDate IS the deed date", () => {
    // Verbatim shape from the live 2026-07-19 query: sold 7/16, three days old.
    const c = deedRowToComp(
      {
        parcel_id: "22063243.",
        address: "12908 GRAYFIELD",
        sale_date: "2026-07-16",
        amt_sale_price: 80_000,
        latitude: 42.371,
        longitude: -83.24,
        zip_code: "48223",
      },
      parcels,
      42.3651,
      -83.2401,
      DETROIT,
    );
    expect(c).not.toBeNull();
    expect(c!.price).toBe(80_000);
    expect(c!.saleDate).toBe("2026-07-16T00:00:00.000Z");
    expect(c!.squareFootage).toBe(1_100);
    expect(c!.yearBuilt).toBe(1941);
    expect(c!.distance).toBeGreaterThan(0.3);
    expect(c!.distance).toBeLessThan(0.5);
    expect(c!.formattedAddress).toBe("12908 GRAYFIELD, Detroit, MI, 48223");
    // Deed ledgers carry no structure beds/baths — nulls pass the beds filter.
    expect(c!.bedrooms).toBeNull();
    expect(c!.removedDate).toBeNull();
  });

  it("no parcel join → sqft null (receipts still show the sale; band math skips it)", () => {
    const c = deedRowToComp(
      { parcel_id: "unknown", address: "1 ELSEWHERE", sale_date: "2026-06-01", amt_sale_price: 50_000, latitude: 42.3, longitude: -83.2 },
      parcels,
      42.3,
      -83.2,
      DETROIT,
    );
    expect(c!.squareFootage).toBeNull();
    expect(c!.price).toBe(50_000);
  });

  it("unusable rows (no price / malformed date) map to nothing", () => {
    expect(deedRowToComp({ sale_date: "2026-07-16", amt_sale_price: 0 }, parcels, null, null, DETROIT)).toBeNull();
    expect(deedRowToComp({ sale_date: "garbage", amt_sale_price: 50_000 }, parcels, null, null, DETROIT)).toBeNull();
  });

  it("no subject coordinates → distance null (passes the distance filter as unknown)", () => {
    const c = deedRowToComp(
      { address: "1 X ST", sale_date: "2026-07-01", amt_sale_price: 60_000, latitude: 42.3, longitude: -83.2 },
      parcels,
      null,
      null,
      DETROIT,
    );
    expect(c!.distance).toBeNull();
  });
});

describe("cuyahogaFeatureToComp — the Fiscal Hub row becomes engine fuel", () => {
  // Verbatim shape from the live 2026-07-20 query (Glenville window):
  // structure data rides the sale row — no parcel join, and unlike
  // Detroit's ledger it carries beds/baths.
  const thornwood = {
    attributes: {
      PARCEL_ID: "105-24-057",
      PCL_ADDR_FULL: "11603 THORNWOOD AVE CLEVELAND, OH 44108",
      SALE_AMOUNT: 26_500,
      SALE_DATE: Date.UTC(2026, 3, 28),
      TOTAL_RES_LIV_AREA: 1_066,
      RES_BEDROOMS: 3,
      RES_BATHS: 1,
      MIN_AGE: 1920, // county schema misnames it; verified to be YEAR BUILT
    },
    centroid: { x: -81.60479, y: 41.52878 },
  };

  it("maps a real warranty-deed sale: recorded price, deed date, on-row structure", () => {
    const c = cuyahogaFeatureToComp(thornwood, 41.53, -81.62);
    expect(c).not.toBeNull();
    expect(c!.price).toBe(26_500);
    expect(c!.saleDate).toBe("2026-04-28T00:00:00.000Z");
    expect(c!.squareFootage).toBe(1_066);
    expect(c!.bedrooms).toBe(3);
    expect(c!.bathrooms).toBe(1);
    expect(c!.yearBuilt).toBe(1920);
    expect(c!.distance).toBeGreaterThan(0.5);
    expect(c!.distance).toBeLessThan(1.1);
    expect(c!.formattedAddress).toBe("11603 THORNWOOD AVE CLEVELAND, OH 44108");
  });

  it("unusable rows (no price / no date) map to nothing", () => {
    expect(cuyahogaFeatureToComp({ attributes: { SALE_DATE: Date.UTC(2026, 3, 28) } }, null, null)).toBeNull();
    expect(cuyahogaFeatureToComp({ attributes: { SALE_AMOUNT: 0, SALE_DATE: Date.UTC(2026, 3, 28) } }, null, null)).toBeNull();
    expect(cuyahogaFeatureToComp({ attributes: { SALE_AMOUNT: 50_000 } }, null, null)).toBeNull();
  });

  it("garbage MIN_AGE (a real age, zero, future year) → yearBuilt null", () => {
    const base = { SALE_AMOUNT: 50_000, SALE_DATE: Date.UTC(2026, 3, 28) };
    expect(cuyahogaFeatureToComp({ attributes: { ...base, MIN_AGE: 105 } }, null, null)!.yearBuilt).toBeNull();
    expect(cuyahogaFeatureToComp({ attributes: { ...base, MIN_AGE: 0 } }, null, null)!.yearBuilt).toBeNull();
    expect(cuyahogaFeatureToComp({ attributes: { ...base, MIN_AGE: 2093 } }, null, null)!.yearBuilt).toBeNull();
  });

  it("no centroid → distance null; empty address → null (unknowns stay unknown)", () => {
    const c = cuyahogaFeatureToComp(
      { attributes: { SALE_AMOUNT: 40_000, SALE_DATE: Date.UTC(2026, 2, 2), PCL_ADDR_FULL: "  " } },
      41.5,
      -81.6,
    );
    expect(c!.distance).toBeNull();
    expect(c!.formattedAddress).toBeNull();
  });
});
