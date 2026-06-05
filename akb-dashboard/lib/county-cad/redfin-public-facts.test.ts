// @agent: appraiser — Redfin Public Facts tax extractor tests.
import { describe, it, expect } from "vitest";
import { extractRedfinTaxHistory } from "./redfin-public-facts";

describe("extractRedfinTaxHistory", () => {
  it("pulls the most-recent year's tax + assessed from a tax-history table", () => {
    const md = [
      "| Year | Property Taxes | Land | Improvements | Total Assessment |",
      "| 2022 | $3,950 (+2.1%) | $30,000 | $148,000 | $178,000 |",
      "| 2023 | $4,287 (+8.5%) | $35,000 | $158,400 | $193,400 |",
      "| 2024 | $4,512 (+5.2%) | $35,000 | $161,310 | $196,310 |",
    ].join("\n");
    const r = extractRedfinTaxHistory(md);
    expect(r.year).toBe(2024);
    expect(r.annualTaxes).toBe(4512);
    expect(r.assessedValue).toBe(196310);
  });

  it("falls back to 'Annual Tax Amount $N' when no table is present", () => {
    const md = "Public Facts ... Annual Tax Amount $4,287 ...";
    const r = extractRedfinTaxHistory(md);
    expect(r.annualTaxes).toBe(4287);
  });

  it("returns nulls when nothing parseable is present", () => {
    expect(extractRedfinTaxHistory("nothing tax-shaped").annualTaxes).toBeNull();
    expect(extractRedfinTaxHistory("").annualTaxes).toBeNull();
  });

  it("ignores absurdly-small / absurdly-large amounts", () => {
    expect(extractRedfinTaxHistory("| 2024 | $42 | $0 | $0 | $0 |").annualTaxes).toBeNull();
    expect(extractRedfinTaxHistory("| 2024 | $400,000 | $0 | $0 | $0 |").annualTaxes).toBeNull();
  });

  it("skips out-of-range years", () => {
    expect(extractRedfinTaxHistory("| 1980 | $4,000 | | | $200,000 |").annualTaxes).toBeNull();
  });
});
