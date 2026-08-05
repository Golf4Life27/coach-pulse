import { describe, it, expect } from "vitest";
import {
  parseAddressFromListingUrl,
  isTextable,
  summarizeEnrichment,
} from "./sweep-enrich";

describe("parseAddressFromListingUrl", () => {
  it("parses a Zillow listing URL", () => {
    const r = parseAddressFromListingUrl(
      "https://www.zillow.com/homedetails/1234-Elm-St-Detroit-MI-48228/12345_zpid/",
    );
    expect(r).toEqual({
      street: "1234 Elm St",
      city: "Detroit",
      state: "MI",
      zip: "48228",
      formatted: "1234 Elm St, Detroit, MI 48228",
    });
  });

  it("parses a Redfin listing URL", () => {
    const r = parseAddressFromListingUrl(
      "https://www.redfin.com/MI/Detroit/1234-Elm-St-48228/home/12345",
    );
    expect(r?.formatted).toBe("1234 Elm St, Detroit, MI 48228");
    expect(r?.state).toBe("MI");
  });

  it("returns null rather than a partial guess", () => {
    // A wrong address spends a RentCast call on the wrong house — and could
    // put a real offer on it.
    expect(parseAddressFromListingUrl("https://www.zillow.com/homedetails/broken/1_zpid/")).toBeNull();
    expect(parseAddressFromListingUrl("https://www.zillow.com/detroit-mi/for_sale/")).toBeNull();
    expect(parseAddressFromListingUrl("not a url")).toBeNull();
    expect(parseAddressFromListingUrl(null)).toBeNull();
  });

  it("rejects a URL whose trailing tokens are not a real state and zip", () => {
    expect(
      parseAddressFromListingUrl("https://www.zillow.com/homedetails/1234-Elm-St-Detroit-Michigan-482/1_zpid/"),
    ).toBeNull();
  });
});

describe("isTextable — the one field that decides lead vs URL", () => {
  it("accepts the shapes normalizePhone accepts", () => {
    expect(isTextable("3135551234")).toBe(true);
    expect(isTextable("(313) 555-1234")).toBe(true);
    expect(isTextable("+1 313 555 1234")).toBe(true);
  });

  it("rejects anything that cannot be dialed", () => {
    expect(isTextable(null)).toBe(false);
    expect(isTextable("")).toBe(false);
    expect(isTextable("555-1234")).toBe(false);
    expect(isTextable("011 44 20 7946 0000")).toBe(false);
  });
});

describe("summarizeEnrichment", () => {
  it("names why qualifiers did not become leads", () => {
    const out = summarizeEnrichment([
      { url: "a", address: "1 A St", recordId: "rec1", skipped: null },
      { url: "b", address: null, recordId: null, skipped: "url_unparseable" },
      { url: "c", address: "3 C St", recordId: null, skipped: "no_agent_phone" },
      { url: "d", address: "4 D St", recordId: null, skipped: "no_agent_phone" },
    ]);
    expect(out).toEqual({
      attempted: 4,
      written: 1,
      by_skip: { url_unparseable: 1, no_agent_phone: 2 },
    });
  });
});
