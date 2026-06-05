// @agent: appraiser — RentCast subject-facts extraction tests.
import { describe, it, expect } from "vitest";
import { extractFacts, extractPhotoUrls, findPhotoFieldKeys, extractAnnualTaxes } from "./rentcast";

describe("extractAnnualTaxes", () => {
  it("returns the most-recent year's tax total", () => {
    expect(
      extractAnnualTaxes({
        propertyTaxes: { "2022": { year: 2022, total: 3800 }, "2023": { year: 2023, total: 4200 } },
      }),
    ).toBe(4200);
  });
  it("returns null when propertyTaxes absent or empty", () => {
    expect(extractAnnualTaxes(undefined)).toBeNull();
    expect(extractAnnualTaxes({})).toBeNull();
    expect(extractAnnualTaxes({ propertyTaxes: {} })).toBeNull();
  });
  it("ignores non-positive / malformed totals", () => {
    expect(extractAnnualTaxes({ propertyTaxes: { "2023": { year: 2023, total: 0 } } })).toBeNull();
    expect(extractAnnualTaxes({ propertyTaxes: { "2023": { year: 2023 } } })).toBeNull();
  });
});

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

describe("extractPhotoUrls", () => {
  it("returns [] for missing record", () => {
    expect(extractPhotoUrls(undefined)).toEqual([]);
  });

  it("pulls plain-string urls off photos[]", () => {
    expect(
      extractPhotoUrls({
        photos: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
      }),
    ).toEqual(["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"]);
  });

  it("unwraps {url} / {originalUrl} objects", () => {
    expect(
      extractPhotoUrls({
        images: [
          { url: "https://cdn.example.com/a.jpg" },
          { originalUrl: "https://cdn.example.com/b.jpg" },
        ],
      }),
    ).toEqual(["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"]);
  });

  it("dedupes and ignores non-http strings", () => {
    expect(
      extractPhotoUrls({
        photos: [
          "https://cdn.example.com/a.jpg",
          "https://cdn.example.com/a.jpg",
          "data:image/jpeg;base64,xxx",
          "",
        ],
      }),
    ).toEqual(["https://cdn.example.com/a.jpg"]);
  });

  it("combines photos + media arrays", () => {
    expect(
      extractPhotoUrls({
        photos: ["https://cdn.example.com/a.jpg"],
        media: [{ src: "https://cdn.example.com/b.jpg" }],
      }),
    ).toEqual(["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"]);
  });
});

describe("findPhotoFieldKeys", () => {
  it("returns [] for missing record", () => {
    expect(findPhotoFieldKeys(undefined)).toEqual([]);
  });

  it("matches photo/image/media keys case-insensitively", () => {
    expect(
      findPhotoFieldKeys({ photos: [], imageUrls: [], mediaItems: [], address: "x" }),
    ).toEqual(["photos", "imageUrls", "mediaItems"]);
  });
});
