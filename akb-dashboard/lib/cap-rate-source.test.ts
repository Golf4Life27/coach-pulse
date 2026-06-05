// @agent: appraiser — market cap-rate sourcing tests.
import { describe, it, expect } from "vitest";
import {
  deriveImpliedCapRate,
  extractMarketMedians,
  sourceMarketCapRate,
} from "./cap-rate-source";

describe("deriveImpliedCapRate", () => {
  it("derives cap = gross_yield × (1 − opex)", () => {
    // median price $200k, median rent $1,500/mo → gross yield
    // = 18000/200000 = 0.09; × (1−0.4) = 0.054.
    const r = deriveImpliedCapRate({ medianSalePrice: 200000, medianRent: 1500, marketOpexRatio: 0.4 });
    expect(r.grossYield).toBe(0.09);
    expect(r.marketImpliedCap).toBe(0.054);
  });

  it("returns null on non-positive medians (no fabricated cap)", () => {
    expect(deriveImpliedCapRate({ medianSalePrice: 0, medianRent: 1500, marketOpexRatio: 0.4 }).marketImpliedCap).toBeNull();
    expect(deriveImpliedCapRate({ medianSalePrice: 200000, medianRent: null, marketOpexRatio: 0.4 }).marketImpliedCap).toBeNull();
  });

  it("rejects an invalid opex ratio", () => {
    expect(deriveImpliedCapRate({ medianSalePrice: 200000, medianRent: 1500, marketOpexRatio: 1 }).marketImpliedCap).toBeNull();
  });
});

describe("extractMarketMedians", () => {
  it("pulls medianPrice / medianRent from RentCast /markets shape", () => {
    const body = {
      saleData: { medianPrice: 215000, averagePrice: 230000 },
      rentalData: { medianRent: 1600, averageRent: 1700 },
    };
    expect(extractMarketMedians(body)).toEqual({ medianSalePrice: 215000, medianRent: 1600 });
  });

  it("falls back to averages when medians absent", () => {
    const body = { saleData: { averagePrice: 230000 }, rentalData: { averageRent: 1700 } };
    expect(extractMarketMedians(body)).toEqual({ medianSalePrice: 230000, medianRent: 1700 });
  });

  it("returns nulls when blocks missing", () => {
    expect(extractMarketMedians({})).toEqual({ medianSalePrice: null, medianRent: null });
    expect(extractMarketMedians(null)).toEqual({ medianSalePrice: null, medianRent: null });
  });
});

describe("sourceMarketCapRate", () => {
  it("sources a cap rate from injected RentCast markets data with provenance", async () => {
    const r = await sourceMarketCapRate("75211", 0.4, {
      fetchMarkets: async () => ({
        status: 200,
        body: { saleData: { medianPrice: 200000 }, rentalData: { medianRent: 1500 } },
      }),
    });
    expect(r.marketImpliedCap).toBe(0.054);
    expect(r.source).toBe("rentcast_markets_derived");
    expect(r.provenance).toContain("RentCast /markets zip 75211");
    expect(r.assumptions.marketOpexRatio).toBe(0.4);
  });

  it("returns capRate:null (HOLD) when markets returns no usable data — never a default", async () => {
    const r = await sourceMarketCapRate("75211", 0.4, {
      fetchMarkets: async () => ({ status: 200, body: {} }),
    });
    expect(r.marketImpliedCap).toBeNull();
    expect(r.error).toMatch(/no usable median/);
  });

  it("returns capRate:null on HTTP error", async () => {
    const r = await sourceMarketCapRate("75211", 0.4, {
      fetchMarkets: async () => ({ status: 429, body: null }),
    });
    expect(r.marketImpliedCap).toBeNull();
    expect(r.error).toContain("429");
  });

  it("rejects an invalid zip", async () => {
    const r = await sourceMarketCapRate("7521", 0.4, { fetchMarkets: async () => ({ status: 200, body: {} }) });
    expect(r.marketImpliedCap).toBeNull();
    expect(r.error).toMatch(/invalid zip/);
  });
});
