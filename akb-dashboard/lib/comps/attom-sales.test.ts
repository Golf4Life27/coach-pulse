import { describe, it, expect } from "vitest";
import { attomSaleToComp } from "./attom-sales";

describe("attomSaleToComp — ATTOM rows become engine fuel, permissively", () => {
  const rec = {
    address: { line1: "1097 FORTRESS AVE SW", locality: "ATLANTA", countrySubd: "GA", postal1: "30315" },
    location: { latitude: 33.7205, longitude: -84.3951 },
    building: { size: { universalsize: 1293 }, rooms: { beds: 2, bathstotal: 2 } },
    summary: { yearbuilt: 1930 },
    sale: { amount: { saleamt: 214_900 }, salesearchdate: "2020-08-14" },
  };

  it("maps recorded price + date; the Fortress canary shape", () => {
    const c = attomSaleToComp(rec, 33.7215, -84.3951);
    expect(c).not.toBeNull();
    expect(c!.price).toBe(214_900);
    expect(c!.saleDate).toBe("2020-08-14T00:00:00.000Z");
    expect(c!.squareFootage).toBe(1_293);
    expect(c!.bedrooms).toBe(2);
    expect(c!.distance).toBeGreaterThan(0);
    expect(c!.distance).toBeLessThan(0.1);
    expect(c!.formattedAddress).toBe("1097 FORTRESS AVE SW, ATLANTA, GA, 30315");
  });

  it("no recorded sale amount/date → null, never a fabricated comp", () => {
    expect(attomSaleToComp({ sale: { amount: {} } }, 33.7, -84.4)).toBeNull();
    expect(attomSaleToComp({ sale: { amount: { saleamt: 100000 } } }, 33.7, -84.4)).toBeNull();
    expect(attomSaleToComp({}, 33.7, -84.4)).toBeNull();
  });

  it("missing structure/coords degrade to nulls (filters treat unknown as passable, band math skips sqft-less)", () => {
    const c = attomSaleToComp({ sale: { amount: { saleamt: 90_000 }, saleTransDate: "2026-05-02" } }, null, null);
    expect(c!.price).toBe(90_000);
    expect(c!.saleDate).toBe("2026-05-02T00:00:00.000Z");
    expect(c!.squareFootage).toBeNull();
    expect(c!.distance).toBeNull();
  });
});
