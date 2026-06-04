// @agent: appraiser — RentCast subject-facts extraction tests.
import { describe, it, expect } from "vitest";
import { extractFacts } from "./rentcast";

describe("extractFacts", () => {
  it("pulls structural facts off a RentCast record", () => {
    expect(
      extractFacts({ squareFootage: 1136, bedrooms: 3, bathrooms: 2, yearBuilt: 1955 }),
    ).toEqual({ squareFootage: 1136, bedrooms: 3, bathrooms: 2, yearBuilt: 1955 });
  });

  it("returns nulls for a missing record", () => {
    expect(extractFacts(undefined)).toEqual({
      squareFootage: null,
      bedrooms: null,
      bathrooms: null,
      yearBuilt: null,
    });
  });

  it("treats zero / negative / non-number as null (RentCast sometimes returns 0)", () => {
    expect(extractFacts({ squareFootage: 0, bedrooms: -1, bathrooms: "2", yearBuilt: null })).toEqual({
      squareFootage: null,
      bedrooms: null,
      bathrooms: null,
      yearBuilt: null,
    });
  });

  it("extracts a valid sqft even when other facts are absent", () => {
    expect(extractFacts({ squareFootage: 1500 })).toEqual({
      squareFootage: 1500,
      bedrooms: null,
      bathrooms: null,
      yearBuilt: null,
    });
  });
});
