// @agent: orchestrator — rent-based landlord lane tests.
import { describe, it, expect } from "vitest";
import { computeLandlordMax } from "./landlord-lane";

describe("computeLandlordMax", () => {
  it("computes value = NOI / cap_rate (the correct ÷ form)", () => {
    // rent $1,500/mo → $18,000/yr; opex 35% → $6,300; taxes $3,000;
    // NOI = 18000 - 6300 - 3000 = 8,700; cap 8% → 8700/0.08 = 108,750.
    const r = computeLandlordMax({
      monthlyRent: 1500,
      annualTaxes: 3000,
      opexRatio: 0.35,
      capRate: 0.08,
    });
    expect(r.status).toBe("ok");
    expect(r.annualGrossRent).toBe(18000);
    expect(r.annualOpex).toBe(6300);
    expect(r.annualNoi).toBe(8700);
    expect(r.landlordValue).toBe(108750);
  });

  it("a lower cap rate yields a HIGHER value (income approach sanity)", () => {
    const base = { monthlyRent: 2000, annualTaxes: 4000, opexRatio: 0.35 };
    const at8 = computeLandlordMax({ ...base, capRate: 0.08 }).landlordValue!;
    const at6 = computeLandlordMax({ ...base, capRate: 0.06 }).landlordValue!;
    expect(at6).toBeGreaterThan(at8);
  });

  it("HOLDs (no fabricated default) when cap rate is missing", () => {
    const r = computeLandlordMax({ monthlyRent: 1500, annualTaxes: 3000, opexRatio: 0.35, capRate: null });
    expect(r.status).toBe("hold");
    expect(r.landlordValue).toBeNull();
    expect(r.missing).toContain("cap_rate");
  });

  it("HOLDs when monthly rent is missing", () => {
    const r = computeLandlordMax({ monthlyRent: null, annualTaxes: 3000, opexRatio: 0.35, capRate: 0.08 });
    expect(r.status).toBe("hold");
    expect(r.missing).toContain("monthly_rent");
  });

  it("HOLDs when taxes are missing (TX taxes are known/derivable — absence is a gap, not a 0)", () => {
    const r = computeLandlordMax({ monthlyRent: 1500, annualTaxes: null, opexRatio: 0.35, capRate: 0.08 });
    expect(r.status).toBe("hold");
    expect(r.missing).toContain("annual_taxes");
  });

  it("HOLDs when opex_ratio is missing (caller must supply an explicit/sourced value)", () => {
    const r = computeLandlordMax({ monthlyRent: 1500, annualTaxes: 3000, opexRatio: null, capRate: 0.08 });
    expect(r.status).toBe("hold");
    expect(r.missing).toContain("opex_ratio");
  });

  it("rejects an out-of-range cap rate (≤0) and opex (≥1)", () => {
    expect(computeLandlordMax({ monthlyRent: 1500, annualTaxes: 3000, opexRatio: 0.35, capRate: 0 }).status).toBe("hold");
    expect(computeLandlordMax({ monthlyRent: 1500, annualTaxes: 3000, opexRatio: 1, capRate: 0.08 }).status).toBe("hold");
  });

  it("accepts taxes of exactly 0 (valid, rare)", () => {
    const r = computeLandlordMax({ monthlyRent: 1500, annualTaxes: 0, opexRatio: 0.35, capRate: 0.08 });
    expect(r.status).toBe("ok");
    expect(r.annualNoi).toBe(18000 - 6300 - 0);
  });

  it("HOLDs (not a fake number) when NOI is non-positive — property doesn't cash-flow", () => {
    // rent $500/mo → $6,000/yr; opex 35% → $2,100; taxes $5,000 → NOI = -1,100.
    const r = computeLandlordMax({ monthlyRent: 500, annualTaxes: 5000, opexRatio: 0.35, capRate: 0.08 });
    expect(r.status).toBe("hold");
    expect(r.landlordValue).toBeNull();
    expect(r.annualNoi).toBeLessThanOrEqual(0);
  });
});
