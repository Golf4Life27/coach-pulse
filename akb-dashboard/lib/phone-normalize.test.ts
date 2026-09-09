import { describe, it, expect } from "vitest";
import { normalizePhone, phonesEqual } from "./phone-normalize";

// This module had no direct test file until 2026-09-09, which is part of why
// the area-code hole below survived long enough to stall the send lane.

describe("normalizePhone — valid shapes", () => {
  it("accepts 10 digits and prefixes +1", () => {
    expect(normalizePhone("4193228620")).toBe("+14193228620");
    expect(normalizePhone("(313) 702-3671")).toBe("+13137023671");
    expect(normalizePhone("313.702.3671")).toBe("+13137023671");
  });

  it("accepts the 11-digit country-coded form", () => {
    expect(normalizePhone("18155569965")).toBe("+18155569965");
    expect(normalizePhone("+1 815 556 9965")).toBe("+18155569965");
  });

  it("strips extensions before counting digits", () => {
    expect(normalizePhone("313-702-3671 x123")).toBe("+13137023671");
    expect(normalizePhone("313-702-3671 ext. 9")).toBe("+13137023671");
  });

  it("rejects anything that is not a plausible NANP length", () => {
    expect(normalizePhone("313702367")).toBeNull(); // 9 digits
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(12345 as unknown as string)).toBeNull();
  });
});

describe("NANP area-code guard — the 26295 Kathy St poison record (2026-09-09)", () => {
  // Agent_Phone was stored as "1313702367": ten digits, a dropped digit off a
  // 313 number. It used to normalize to +11313702367 — area code "131", which
  // a NANP number can never have. Because the result was non-null it skipped
  // bad_phone_quarantine entirely and was handed to Quo on EVERY run, which
  // rejected it forever. Two records like this drained the eligible queue to
  // zero and made Pulse cry "send lane firing blanks" every 30 minutes.

  it("rejects a 10-digit number whose area code starts with 1 or 0", () => {
    expect(normalizePhone("1313702367")).toBeNull();
    expect(normalizePhone("0313702367")).toBeNull();
  });

  it("rejects the 11-digit form of the same impossibility", () => {
    expect(normalizePhone("11313702367")).toBeNull();
    expect(normalizePhone("10313702367")).toBeNull();
  });

  it("does not over-reach — a leading 1 is still a valid country code", () => {
    // "1" + a REAL area code must survive; only 1/0 in the area-code slot dies.
    expect(normalizePhone("13137023671")).toBe("+13137023671");
    expect(normalizePhone("14193228620")).toBe("+14193228620");
  });
});

describe("phonesEqual", () => {
  it("matches across formatting", () => {
    expect(phonesEqual("(419) 322-8620", "4193228620")).toBe(true);
    expect(phonesEqual("+14193228620", "419.322.8620")).toBe(true);
  });

  it("is false when either side is unusable", () => {
    expect(phonesEqual(null, "4193228620")).toBe(false);
    expect(phonesEqual("1313702367", "1313702367")).toBe(false); // both invalid now
  });
});
