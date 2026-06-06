// @agent: appraiser — ATTOM property URL builders, mappers, ARV synth tests.
import { describe, it, expect } from "vitest";
import {
  buildAddress2,
  buildPropertyDetailUrl,
  buildAssessmentDetailUrl,
  buildSalesComparablesUrl,
  mapPropertyDetail,
  mapAssessmentDetail,
  mapSalesComparables,
  synthesizeArv,
  type SoldComp,
} from "./property";

describe("URL builders", () => {
  it("buildAddress2 joins city/state/zip cleanly", () => {
    expect(buildAddress2("Detroit", "MI", "48206")).toBe("Detroit, MI 48206");
    expect(buildAddress2("Detroit", "MI", "48206 ")).toBe("Detroit, MI 48206");
  });
  it("property/detail uses address1/address2 query params", () => {
    const u = buildPropertyDetailUrl({ address1: "1973 Sturtevant St", address2: "Detroit, MI 48206" });
    expect(u).toContain("/property/detail");
    expect(u).toContain("address1=1973+Sturtevant+St");
    expect(u).toContain("address2=Detroit%2C+MI+48206");
  });
  it("assessment/detail uses the same convention", () => {
    const u = buildAssessmentDetailUrl({ address1: "5435 Callaghan Rd", address2: "San Antonio, TX 78228" });
    expect(u).toContain("/assessment/detail");
    expect(u).toContain("address1=5435+Callaghan+Rd");
  });
  it("salescomparables/address uses path segments (street/city/county/state/zip)", () => {
    const u = buildSalesComparablesUrl("1973 Sturtevant St", "Detroit", "MI", "48206");
    // Path order: street/city/county/state/zip — county defaults to "0".
    expect(u).toContain("/salescomparables/address/");
    expect(u).toContain("/1973%20Sturtevant%20St/");
    expect(u).toContain("/Detroit/0/MI/48206");
  });
  it("salescomparables accepts radius + min/max comp params", () => {
    const u = buildSalesComparablesUrl("X", "Y", "MI", "48206", { searchRadiusMi: 2, minComps: 5, maxComps: 15 });
    expect(u).toContain("searchRadius=2");
    expect(u).toContain("minComps=5");
    expect(u).toContain("maxComps=15");
  });
});

describe("response mappers", () => {
  it("mapPropertyDetail extracts beds/baths/sqft/year + propertyType", () => {
    const r = mapPropertyDetail({
      property: [{
        summary: { propsubtype: "Single Family", yearbuilt: 1955 },
        building: { rooms: { beds: 3, bathstotal: 2 }, size: { livingsize: 1200 } },
      }],
    });
    expect(r.beds).toBe(3);
    expect(r.baths).toBe(2);
    expect(r.sqft).toBe(1200);
    expect(r.yearBuilt).toBe(1955);
    expect(r.propertyType).toBe("Single Family");
  });
  it("mapPropertyDetail returns all-null on empty body", () => {
    expect(mapPropertyDetail({}).beds).toBeNull();
    expect(mapPropertyDetail({ property: [] }).sqft).toBeNull();
  });

  it("mapAssessmentDetail extracts tax + assessed value", () => {
    const r = mapAssessmentDetail({
      property: [{ assessment: { tax: { taxAmt: 4515, taxYear: 2025 }, assessed: { assdttlvalue: 196310 } } }],
    });
    expect(r.annualTaxes).toBe(4515);
    expect(r.assessedValue).toBe(196310);
    expect(r.taxYear).toBe(2025);
  });
  it("mapAssessmentDetail falls back to market value when assessed missing", () => {
    const r = mapAssessmentDetail({
      property: [{ assessment: { market: { mktttlvalue: 220000 } } }],
    });
    expect(r.assessedValue).toBe(220000);
  });

  it("mapSalesComparables extracts amount/date/sqft from the flat shape", () => {
    const comps = mapSalesComparables({
      comparables: [
        { amount: { saleamt: 145000 }, salesearchdate: "2025-03-12", size: { livingsize: 1150 }, address: { line1: "1979 Sturtevant" } },
        { amount: { saleamt: 138000 }, salesearchdate: "2025-04-01", size: { livingsize: 1100 } },
        { amount: { saleamt: 0 } }, // dropped: non-positive
        { amount: {} },              // dropped: missing
      ],
    });
    expect(comps).toHaveLength(2);
    expect(comps[0].saleAmount).toBe(145000);
    expect(comps[0].sqft).toBe(1150);
  });
  it("mapSalesComparables accepts the nested property[].sale shape too", () => {
    const comps = mapSalesComparables({
      property: [
        { sale: { amount: { saleamt: 150000 }, salesearchdate: "2025-05-01" } },
        { sale: { amount: { saleamt: 142000 } } },
      ],
    });
    expect(comps).toHaveLength(2);
  });
});

describe("ARV synthesizer — recorded comps only, never AVM", () => {
  const comp = (amount: number, sqft: number | null = 1100): SoldComp => ({
    saleAmount: amount, saleDate: "2025-04-01", sqft, address: null,
  });

  it("median of clean comps → ARV", () => {
    const r = synthesizeArv([comp(140000), comp(145000), comp(150000)]);
    expect(r.status).toBe("ok");
    expect(r.arv).toBe(145000);
    expect(r.medianPricePerSqft).toBeGreaterThan(0);
  });

  it("HOLD on insufficient comps (<3) — never fabricate ARV from 1 sale", () => {
    expect(synthesizeArv([comp(145000), comp(150000)]).status).toBe("hold");
    expect(synthesizeArv([]).arv).toBeNull();
  });

  it("HOLD on excessive dispersion (>25% MAD/median) — comp set too noisy", () => {
    // Median 145k, but MAD = 35k (huge swings) → 24%... let me push further.
    // 100k, 145k, 200k → median 145, abs devs 45/0/55 → MAD 45 → 31% → HOLD.
    const r = synthesizeArv([comp(100000), comp(145000), comp(200000)]);
    expect(r.status).toBe("hold");
    expect(r.reason).toContain("dispersion");
  });

  it("PASSES the Sturtevant anchor band (~$145k validation case)", () => {
    // Brigana's boots-on-ground anchor: ~$145k retail comp on Sturtevant St.
    // A clean 5-comp set near anchor → ARV near anchor.
    const r = synthesizeArv([comp(138000), comp(142000), comp(145000), comp(149000), comp(152000)]);
    expect(r.status).toBe("ok");
    expect(r.arv).toBeGreaterThanOrEqual(140000);
    expect(r.arv).toBeLessThanOrEqual(150000);
  });

  it("median $/sqft is computed when ≥3 comps carry sqft", () => {
    const r = synthesizeArv([comp(140000, 1100), comp(145000, 1150), comp(150000, 1200)]);
    expect(r.medianPricePerSqft).not.toBeNull();
  });
});
