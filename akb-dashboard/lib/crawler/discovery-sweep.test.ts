import { describe, it, expect } from "vitest";
import {
  isListingUrl,
  buildZipSearchQuery,
  screenCandidate,
  summarizeScreens,
  type SweepCandidate,
} from "./discovery-sweep";

const base: SweepCandidate = {
  url: "https://www.zillow.com/homedetails/1234-Elm-St-Detroit-MI-48228/12345_zpid/",
  zip: "48228",
  city: "Detroit",
  price: 45_000,
  sqft: 1_200,
  beds: 3,
  baths: 1,
  yearBuilt: 1950,
  daysOnMarket: 90,
  text: "Sold as-is, investor special, needs work throughout.",
  stillActive: true,
};

describe("isListingUrl — never pay to scrape an index page", () => {
  it("accepts real listing pages", () => {
    expect(isListingUrl(base.url)).toBe(true);
    expect(isListingUrl("https://www.redfin.com/MI/Detroit/1234-Elm-St-48228/home/12345")).toBe(true);
  });

  it("rejects search and browse pages", () => {
    expect(isListingUrl("https://www.zillow.com/detroit-mi/for_sale/")).toBe(false);
    expect(isListingUrl("https://www.redfin.com/city/5665/MI/Detroit")).toBe(false);
    expect(isListingUrl("https://www.zillow.com/profile/some-agent/")).toBe(false);
  });

  it("rejects non-portal and malformed URLs", () => {
    expect(isListingUrl("https://example.com/1234-Elm-St")).toBe(false);
    expect(isListingUrl(null)).toBe(false);
    expect(isListingUrl("")).toBe(false);
  });
});

describe("buildZipSearchQuery", () => {
  it("biases the search toward motivated copy, not every active listing", () => {
    const q = buildZipSearchQuery("48228", "Detroit", "MI");
    expect(q).toContain("48228");
    expect(q).toContain("Detroit MI");
    expect(q).toMatch(/as-is|investor special|fixer/);
  });
});

describe("screenCandidate", () => {
  it("accepts a real target", () => {
    const s = screenCandidate(base);
    expect(s.accept).toBe(true);
    expect(s.distress).toContain("dom_90");
    expect(s.distress).toContain("distress_language");
  });

  it("requires a distress signal — a clean aged-free listing is not a deal", () => {
    const s = screenCandidate({ ...base, daysOnMarket: 10, text: "Lovely home in a quiet street." });
    expect(s.accept).toBe(false);
    expect(s.reasons).toContain("no_distress_signal");
  });

  it("rejects an ask above the metro ceiling", () => {
    // Flat Shoals: $375,000 in Atlanta.
    const s = screenCandidate({ ...base, city: "Atlanta", zip: "30316", price: 375_000 });
    expect(s.reasons).toContain("ask_above_ceiling");
  });

  it("rejects landlord-priced listings that show no distress of their own", () => {
    // The 2943 Hillside class.
    const s = screenCandidate({
      ...base,
      daysOnMarket: 81,
      text: "ideal for investors seeking stable cash flow, expanding a rental portfolio",
    });
    expect(s.accept).toBe(false);
    expect(s.reasons).toContain("landlord_priced");
  });

  it("still takes a distressed listing that happens to mention a proforma", () => {
    const s = screenCandidate({
      ...base,
      text: "Investor special, needs work. Proforma available on request.",
    });
    expect(s.reasons).not.toContain("landlord_priced");
    expect(s.accept).toBe(true);
  });

  it("honours the hard vetoes decided upstream", () => {
    expect(screenCandidate({ ...base, renovated: true }).reasons).toContain("renovated");
    expect(screenCandidate({ ...base, wholesalerExcluded: true }).reasons).toContain("wholesaler_excluded");
    expect(screenCandidate({ ...base, stillActive: false }).reasons).toContain("not_active");
  });

  it("does NOT reject on unknowns — unreadable is not the same as failing", () => {
    // Beds/sqft/year absent: pass to enrichment rather than guess (INVARIANTS §1).
    const s = screenCandidate({ ...base, beds: null, sqft: null, yearBuilt: null });
    expect(s.accept).toBe(true);
  });

  it("rejects shape that is affirmatively out of band", () => {
    expect(screenCandidate({ ...base, beds: 1 }).reasons).toContain("beds_below_min");
    expect(screenCandidate({ ...base, sqft: 400 }).reasons).toContain("sqft_out_of_band");
    expect(screenCandidate({ ...base, yearBuilt: 2015 }).reasons).toContain("year_built_out_of_band");
  });

  it("counts a 5% cut as motivation and a 2% cut as anchoring", () => {
    const cut = { ...base, daysOnMarket: 10, text: "Priced well." };
    expect(screenCandidate({ ...cut, priceCutPct: 0.06 }).distress[0]).toContain("price_cut");
    expect(screenCandidate({ ...cut, priceCutPct: 0.02 }).reasons).toContain("no_distress_signal");
  });
});

describe("summarizeScreens", () => {
  it("reports why a ZIP produced nothing, not just that it did", () => {
    const out = summarizeScreens([
      screenCandidate(base),
      screenCandidate({ ...base, price: 375_000, city: "Atlanta" }),
      screenCandidate({ ...base, daysOnMarket: 3, text: "nice home" }),
    ]);
    expect(out.examined).toBe(3);
    expect(out.qualified).toBe(1);
    expect(out.by_reason.ask_above_ceiling).toBe(1);
    expect(out.by_reason.no_distress_signal).toBe(1);
  });
});
