// @agent: appraiser — ATTOM property URL builders, mappers, ARV synth tests.
import { describe, it, expect } from "vitest";
import {
  buildAddress2,
  buildPropertyDetailUrl,
  buildAssessmentDetailUrl,
  buildSalesComparablesUrl,
  normalizeStreetForAttom,
  mapPropertyDetail,
  mapAssessmentDetail,
  mapSalesComparables,
  synthesizeArv,
  type SoldComp,
} from "./property";

const NOW = new Date("2026-06-06T00:00:00.000Z");
const recent = "2026-03-01T00:00:00.000Z";

describe("URL builders", () => {
  it("buildAddress2 joins city/state/zip cleanly", () => {
    expect(buildAddress2("Detroit", "MI", "48206")).toBe("Detroit, MI 48206");
    expect(buildAddress2("Detroit", "MI", "48206 ")).toBe("Detroit, MI 48206");
  });
  it("property/detail uses address1/address2 query params", () => {
    const u = buildPropertyDetailUrl({ address1: "1973 Sturtevant St", address2: "Detroit, MI 48206" });
    expect(u).toContain("/property/detail");
    expect(u).toContain("address1=1973+STURTEVANT+ST");
    expect(u).toContain("address2=Detroit%2C+MI+48206");
  });
  it("assessment/detail uses the same convention", () => {
    const u = buildAssessmentDetailUrl({ address1: "5435 Callaghan Rd", address2: "San Antonio, TX 78228" });
    expect(u).toContain("/assessment/detail");
    expect(u).toContain("address1=5435+CALLAGHAN+RD");
  });
  it("salescomparables/address uses the property/v2 base + path segments (street/city/county/state/zip)", () => {
    const u = buildSalesComparablesUrl("1973 Sturtevant St", "Detroit", "MI", "48206");
    // Sales Comparables is under property/v2, NOT propertyapi/v1.0.0
    // (v1.0.0 → 404 "No rule matched"; confirmed live 2026-06-06).
    expect(u).toContain("/property/v2/salescomparables/address/");
    expect(u).not.toContain("propertyapi/v1.0.0/salescomparables");
    expect(u).toContain("/1973%20STURTEVANT%20ST/");
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

  it("mapAssessmentDetail extracts tax + assessed value (lowercase ATTOM field names)", () => {
    const r = mapAssessmentDetail({
      property: [{ assessment: { tax: { taxamt: 4515, taxyear: 2025 }, assessed: { assdttlvalue: 196310 } } }],
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
  it("mapSalesComparables parses the REAL v2 MISMO envelope (confirmed live 2026-06-06)", () => {
    // Trimmed real Sturtevant response: subject (REO, non-arms-length) +
    // two arms-length comps. The subject's own sale must NOT be a comp.
    const body = {
      RESPONSE_GROUP: {
        RESPONSE: {
          RESPONSE_DATA: {
            PROPERTY_INFORMATION_RESPONSE_ext: {
              SUBJECT_PROPERTY_ext: {
                PROPERTY: [
                  {
                    PRODUCT_INFO_ext: { "@Product_ext": "SalesCompSubjectProperty" },
                    SALES_HISTORY: { "@PropertySalesAmount": "17000", "@PropertySalesDate": "2023-07-07T00:00:00" },
                  },
                  {
                    COMPARABLE_PROPERTY_ext: {
                      "@_Sequence": "1",
                      "@_StreetAddress": "1568 HIGHLAND ST",
                      SALES_HISTORY: { "@PropertySalesAmount": "65000.00", "@TransferDate_ext": "2026-01-28T00:00:00", "@ArmsLengthTransactionIndicatorExt": "A" },
                      STRUCTURE: { "@GrossLivingAreaSquareFeetCount": "1344" },
                    },
                  },
                  {
                    COMPARABLE_PROPERTY_ext: {
                      "@_Sequence": "2",
                      "@_StreetAddress": "1689 TYLER ST",
                      SALES_HISTORY: { "@PropertySalesAmount": "77300.00", "@TransferDate_ext": "2025-12-17T00:00:00", "@ArmsLengthTransactionIndicatorExt": "A" },
                      STRUCTURE: { "@GrossLivingAreaSquareFeetCount": "1260" },
                    },
                  },
                  {
                    COMPARABLE_PROPERTY_ext: {
                      "@_Sequence": "3",
                      "@_StreetAddress": "999 NONARM ST",
                      SALES_HISTORY: { "@PropertySalesAmount": "5000.00", "@TransferDate_ext": "2025-11-01T00:00:00", "@ArmsLengthTransactionIndicatorExt": "Q" },
                      STRUCTURE: { "@GrossLivingAreaSquareFeetCount": "1000" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const comps = mapSalesComparables(body as never);
    // 2 arms-length comps; subject ($17k REO) + non-arms-length ("Q") excluded.
    expect(comps).toHaveLength(2);
    expect(comps.map((c) => c.saleAmount).sort((a, b) => a - b)).toEqual([65000, 77300]);
    expect(comps[0].address).toBe("1568 HIGHLAND ST");
    expect(comps[0].sqft).toBe(1344);
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

describe("normalizeStreetForAttom", () => {
  it("uppercases, collapses whitespace, drops punctuation", () => {
    expect(normalizeStreetForAttom("  1973  Sturtevant St. ")).toBe("1973 STURTEVANT ST");
    expect(normalizeStreetForAttom("1620 W. Grand Blvd,")).toBe("1620 W GRAND BLVD");
  });
  it("strips trailing unit designators (the ATTOM 400 class)", () => {
    expect(normalizeStreetForAttom("123 Main St Apt 4B")).toBe("123 MAIN ST");
    expect(normalizeStreetForAttom("55 Oak Ave #200")).toBe("55 OAK AVE");
    expect(normalizeStreetForAttom("9 Elm Dr Unit 12")).toBe("9 ELM DR");
  });
  it("handles null/empty", () => {
    expect(normalizeStreetForAttom(null)).toBe("");
    expect(normalizeStreetForAttom("")).toBe("");
  });
});

describe("ARV synthesizer — RENOVATED-cluster, recorded comps only, never AVM", () => {
  const comp = (amount: number, sqft: number | null = 1100, saleDate: string | null = recent): SoldComp => ({
    saleAmount: amount, saleDate, sqft, address: null,
  });

  it("unimodal clean set → ARV = median sale (no subjectSqft)", () => {
    const r = synthesizeArv([comp(140000), comp(145000), comp(150000)], { now: NOW });
    expect(r.status).toBe("ok");
    expect(r.bimodal).toBe(false);
    expect(r.arv).toBe(145000);
  });

  it("BIMODAL Detroit set → ARV from the RENOVATED cluster; distressed excluded", () => {
    // Distressed cluster ~$15–18/sqft (REO), renovated ~$50–62/sqft (retail).
    // 1100 sqft each. Largest gap dominates → split. Renovated median ≈ $55/sqft.
    const distressed = [comp(16500, 1100), comp(17600, 1100), comp(18700, 1100)]; // 15/16/17 psf
    const renovated = [comp(55000, 1100), comp(60500, 1100), comp(64900, 1100), comp(68200, 1100)]; // 50/55/59/62
    const r = synthesizeArv([...distressed, ...renovated], { subjectSqft: 1100, now: NOW });
    expect(r.status).toBe("ok");
    expect(r.bimodal).toBe(true);
    expect(r.renovatedCount).toBe(4);
    expect(r.distressedCount).toBe(3);
    // ARV ≈ renovated median $/sqft (≈$57) × 1100 ≈ $62k — NOT the ~$17k distressed.
    expect(r.arv!).toBeGreaterThan(55000);
    expect(r.arv!).toBeLessThan(70000);
    expect(r.distressedMedianPpsf!).toBeLessThan(20);
  });

  it("subjectSqft scales the renovated $/sqft to the subject", () => {
    const renovated = [comp(55000, 1100), comp(60500, 1100), comp(66000, 1100)]; // 50/55/60 psf, median 55
    const r = synthesizeArv(renovated, { subjectSqft: 1400, now: NOW });
    // unimodal, median $/sqft ≈ 55 × 1400 ≈ 77000
    expect(r.arv!).toBeGreaterThan(73000);
    expect(r.arv!).toBeLessThan(81000);
  });

  it("HOLD on insufficient recent comps (<3)", () => {
    expect(synthesizeArv([comp(145000), comp(150000)], { now: NOW }).status).toBe("hold");
    expect(synthesizeArv([], { now: NOW }).arv).toBeNull();
  });

  it("HOLD when renovated cluster dispersion exceeds the bound", () => {
    // wildly scattered $/sqft, unimodal, MAD/median > 25%.
    const r = synthesizeArv([comp(90000, 1100), comp(145000, 1100), comp(210000, 1100)], { now: NOW });
    expect(r.status).toBe("hold");
    expect(r.reason).toContain("dispersion");
  });

  it("drops stale comps (older than the recency window)", () => {
    const stale = "2022-01-01T00:00:00.000Z";
    const r = synthesizeArv(
      [comp(60000, 1100, stale), comp(61000, 1100, stale), comp(150000, 1100, recent)],
      { now: NOW },
    );
    // only 1 recent comp survives → HOLD.
    expect(r.status).toBe("hold");
  });

  it("does NOT use the arv_uplift.json 2.0× multiplier (clustering only)", () => {
    // A clean renovated set must yield the cluster median, never median×2.
    const r = synthesizeArv([comp(60000, 1100), comp(62000, 1100), comp(64000, 1100)], { subjectSqft: 1100, now: NOW });
    expect(r.arv!).toBeLessThan(70000); // ≈ $62k, not ~$124k
  });
});
