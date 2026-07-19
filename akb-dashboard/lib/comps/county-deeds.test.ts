import { describe, it, expect } from "vitest";
import {
  countyDeedSourceFor,
  deedRowToComp,
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
