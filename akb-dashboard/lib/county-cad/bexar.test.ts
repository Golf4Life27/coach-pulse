// @agent: appraiser — Bexar CAD tax extraction tests.
import { describe, it, expect } from "vitest";
import {
  extractAnnualTaxesFromCadMarkdown,
  extractAssessedValueFromCadMarkdown,
  buildBexarCadQuery,
  buildBexarCadDirectSearchUrl,
} from "./bexar";

describe("extractAnnualTaxesFromCadMarkdown", () => {
  it("pulls 'Estimated Taxes' / dollar amount pairs", () => {
    const md = "Property summary ... Estimated Taxes: $3,847.21 Total Value $185,000";
    const r = extractAnnualTaxesFromCadMarkdown(md);
    expect(r.total).toBe(3847);
    expect(r.matchContext).toMatch(/Estimated Taxes/i);
  });

  it("pulls 'Total Tax Levy'", () => {
    const md = "...Total Tax Levy $4,123 ...";
    expect(extractAnnualTaxesFromCadMarkdown(md).total).toBe(4123);
  });

  it("returns null when no tax phrases present", () => {
    expect(extractAnnualTaxesFromCadMarkdown("nothing here").total).toBeNull();
  });

  it("ignores absurdly-low numbers (< $100) that aren't a real annual tax", () => {
    const md = "Estimated Taxes: $42 (per parcel?)";
    expect(extractAnnualTaxesFromCadMarkdown(md).total).toBeNull();
  });

  it("ignores absurdly-high numbers (≥ $200k) — not a residential annual tax", () => {
    const md = "Estimated Taxes: $400,000";
    expect(extractAnnualTaxesFromCadMarkdown(md).total).toBeNull();
  });
});

describe("extractAssessedValueFromCadMarkdown", () => {
  it("pulls Market / Appraised / Assessed values, takes the highest", () => {
    const md = "Market Value $185,000 ... Appraised Value $170,000 ... Assessed Value $160,000";
    expect(extractAssessedValueFromCadMarkdown(md)).toBe(185_000);
  });

  it("returns null when no value phrases present", () => {
    expect(extractAssessedValueFromCadMarkdown("...")).toBeNull();
  });
});

describe("buildBexarCadQuery", () => {
  it("includes the address + zip + Bexar CAD site scope", () => {
    const q = buildBexarCadQuery({ address: "5435 Callaghan Rd", city: "San Antonio", zip: "78228" });
    expect(q).toContain("5435 Callaghan Rd");
    expect(q).toContain("78228");
    expect(q).toMatch(/site:bcad\.org/);
  });
});

describe("buildBexarCadDirectSearchUrl", () => {
  it("builds the search.bcad.org URL with the address URL-encoded", () => {
    const u = buildBexarCadDirectSearchUrl({ address: "5435 Callaghan Rd" });
    expect(u).toBe("https://search.bcad.org/Search/Result?searchString=5435%20Callaghan%20Rd");
  });
});
