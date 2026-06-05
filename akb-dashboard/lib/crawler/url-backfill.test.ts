// @agent: scout — strict address↔URL confirmation tests.
import { describe, it, expect } from "vitest";
import { strictAddressUrlMatch, formatSubjectAddress } from "./url-backfill";

const REDFIN = "https://www.redfin.com/TX/Dallas/924-Sunnyside-Ave-75211/home/32118136";

describe("strictAddressUrlMatch", () => {
  it("confirms when street number AND a name token are in the URL slug", () => {
    const m = strictAddressUrlMatch("924 Sunnyside Ave", REDFIN);
    expect(m.matched).toBe(true);
    expect(m.reason).toBe("matched");
    expect(m.streetNumber).toBe("924");
    expect(m.matchedToken).toBe("sunnyside");
  });

  it("rejects when the street number is absent from the URL (neighbor/comp)", () => {
    // Same street, different house number — must NOT confirm.
    const m = strictAddressUrlMatch("930 Sunnyside Ave", REDFIN);
    expect(m.matched).toBe(false);
    expect(m.reason).toBe("number_absent_from_url");
  });

  it("rejects when the name token doesn't match (number coincidence)", () => {
    // 924 appears but the street name (Elm) does not.
    const m = strictAddressUrlMatch("924 Elm St", REDFIN);
    expect(m.matched).toBe(false);
    expect(m.reason).toBe("no_name_token_match");
  });

  it("rejects an empty/missing URL", () => {
    expect(strictAddressUrlMatch("924 Sunnyside Ave", null).reason).toBe("empty_url");
    expect(strictAddressUrlMatch("924 Sunnyside Ave", "").reason).toBe("empty_url");
  });

  it("rejects an address with no street number", () => {
    const m = strictAddressUrlMatch("Sunnyside Ave", REDFIN);
    expect(m.matched).toBe(false);
    expect(m.reason).toBe("no_street_number");
  });

  it("does not count street-type/directional suffixes as distinguishing tokens", () => {
    // Only stopword tokens after the number → can't strictly confirm.
    const m = strictAddressUrlMatch("100 N Ave", "https://redfin.com/TX/Dallas/100-N-Ave/home/1");
    expect(m.matched).toBe(false);
    expect(m.reason).toBe("no_distinguishing_tokens");
  });

  it("matches a multi-word street name on any one distinguishing token", () => {
    const url = "https://www.redfin.com/TN/Memphis/23-Fields-Ave-38109/home/87658196";
    const m = strictAddressUrlMatch("23 Fields Ave", url);
    expect(m.matched).toBe(true);
    expect(m.matchedToken).toBe("fields");
  });

  it("is robust to punctuation/case differences between address and slug", () => {
    const url = "https://www.zillow.com/homedetails/5705-Glen-Forest-Ln-Dallas-TX-75241/12345_zpid/";
    const m = strictAddressUrlMatch("5705 Glen Forest Ln", url);
    expect(m.matched).toBe(true);
    // first distinguishing token is "glen"
    expect(m.matchedToken).toBe("glen");
  });
});

describe("formatSubjectAddress", () => {
  it("builds 'street, city state zip'", () => {
    expect(
      formatSubjectAddress({ address: "924 Sunnyside Ave", city: "Dallas", state: "TX", zip: "75211" }),
    ).toBe("924 Sunnyside Ave, Dallas TX 75211");
  });

  it("omits missing parts cleanly", () => {
    expect(
      formatSubjectAddress({ address: "924 Sunnyside Ave", city: null, state: "TX", zip: null }),
    ).toBe("924 Sunnyside Ave, TX");
    expect(
      formatSubjectAddress({ address: "924 Sunnyside Ave", city: null, state: null, zip: null }),
    ).toBe("924 Sunnyside Ave");
  });
});
