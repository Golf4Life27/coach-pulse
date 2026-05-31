import { describe, it, expect } from "vitest";
import {
  deriveWholesaleRestricted,
  deriveMemphisRequired,
  WHOLESALE_RESTRICTED_STATES,
} from "./zip-registry";

describe("deriveWholesaleRestricted", () => {
  it("is true for each restricted state", () => {
    for (const s of WHOLESALE_RESTRICTED_STATES) {
      expect(deriveWholesaleRestricted(s)).toBe(true);
    }
  });

  it("is false for active markets (TX, TN)", () => {
    expect(deriveWholesaleRestricted("TX")).toBe(false);
    expect(deriveWholesaleRestricted("TN")).toBe(false);
  });

  it("normalizes case + whitespace", () => {
    expect(deriveWholesaleRestricted(" il ")).toBe(true);
    expect(deriveWholesaleRestricted("nc")).toBe(true);
  });

  it("is false for null / empty", () => {
    expect(deriveWholesaleRestricted(null)).toBe(false);
    expect(deriveWholesaleRestricted(undefined)).toBe(false);
    expect(deriveWholesaleRestricted("")).toBe(false);
  });
});

describe("deriveMemphisRequired", () => {
  it("is true only for TN", () => {
    expect(deriveMemphisRequired("TN")).toBe(true);
    expect(deriveMemphisRequired(" tn ")).toBe(true);
  });

  it("is false for other states", () => {
    expect(deriveMemphisRequired("TX")).toBe(false);
    expect(deriveMemphisRequired("GA")).toBe(false);
    expect(deriveMemphisRequired(null)).toBe(false);
  });
});
