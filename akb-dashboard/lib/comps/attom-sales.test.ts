import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attomSaleToComp, getAttomSaleComps, ATTOM_MIN_SALE_PRICE } from "./attom-sales";
import { _resetMemoryRing, RENTCAST_LOOP_TRIP_AFTER } from "@/lib/rentcast/failure-loop-breaker";

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

  it("sub-$10k nominal deed transfers never become comps (the $4,542/$4,000 benchmark rows)", () => {
    expect(
      attomSaleToComp({ sale: { amount: { saleamt: 4_542 }, salesearchdate: "2026-03-11" } }, 33.7, -84.4),
    ).toBeNull();
    expect(
      attomSaleToComp({ sale: { amount: { saleamt: 4_000 }, salesearchdate: "2026-01-20" } }, 33.7, -84.4),
    ).toBeNull();
    // Exactly at the floor is a (barely) plausible market price — it passes
    // here; the distressed-proxy ZIP-median clip still applies downstream.
    const c = attomSaleToComp(
      { sale: { amount: { saleamt: ATTOM_MIN_SALE_PRICE }, salesearchdate: "2026-02-02" } },
      33.7,
      -84.4,
    );
    expect(c!.price).toBe(ATTOM_MIN_SALE_PRICE);
  });

  it("missing structure/coords degrade to nulls (filters treat unknown as passable, band math skips sqft-less)", () => {
    const c = attomSaleToComp({ sale: { amount: { saleamt: 90_000 }, saleTransDate: "2026-05-02" } }, null, null);
    expect(c!.price).toBe(90_000);
    expect(c!.saleDate).toBe("2026-05-02T00:00:00.000Z");
    expect(c!.squareFootage).toBeNull();
    expect(c!.distance).toBeNull();
  });
});

describe("getAttomSaleComps — failure-loop breaker on the promoted path", () => {
  beforeEach(() => {
    _resetMemoryRing();
    process.env.ATTOM_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ATTOM_API_KEY;
  });

  it("a stable failing shape stops billing after the trip threshold", async () => {
    const fetchMock = vi.fn(async () => new Response("entitlement denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER; i++) {
      await expect(getAttomSaleComps(42.36, -83.09)).rejects.toThrow("401");
    }
    // Next tick: short-circuits BEFORE the paid fetch — the throw routes
    // the caller to its fallback, and ATTOM is never billed again.
    await expect(getAttomSaleComps(42.36, -83.09)).rejects.toThrow(/loop breaker tripped/);
    expect(fetchMock).toHaveBeenCalledTimes(RENTCAST_LOOP_TRIP_AFTER);
  });

  it("honest zeros (SuccessWithoutResult) never count toward a trip", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: { msg: "SuccessWithoutResult" } }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i <= RENTCAST_LOOP_TRIP_AFTER; i++) {
      await expect(getAttomSaleComps(42.36, -83.09)).resolves.toEqual([]);
    }
    // Every call went through — an answered "no sales here" is not a failure.
    expect(fetchMock).toHaveBeenCalledTimes(RENTCAST_LOOP_TRIP_AFTER + 1);
  });

  it("a success clears the counter (transient blips never accumulate to a trip)", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls % 2 === 1) return new Response("upstream hiccup", { status: 502 });
      return new Response(JSON.stringify({ property: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    for (let round = 0; round < RENTCAST_LOOP_TRIP_AFTER + 1; round++) {
      await expect(getAttomSaleComps(42.36, -83.09)).rejects.toThrow("502");
      await expect(getAttomSaleComps(42.36, -83.09)).resolves.toEqual([]);
    }
    expect(fetchMock).toHaveBeenCalledTimes((RENTCAST_LOOP_TRIP_AFTER + 1) * 2);
  });
});
