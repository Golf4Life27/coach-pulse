import { describe, it, expect } from "vitest";
import { toE164, isPlausibleUsPhone } from "./phone";

describe("toE164", () => {
  it("normalizes a bare 10-digit US number with +1", () => {
    expect(toE164("9012200869")).toBe("+19012200869");
  });

  it("strips formatting from a (xxx) xxx-xxxx number", () => {
    expect(toE164("(901) 220-0869")).toBe("+19012200869");
  });

  it("preserves an already-E164 number with country code", () => {
    expect(toE164("+19012200869")).toBe("+19012200869");
  });

  it("handles an 11-digit leading-1 input", () => {
    expect(toE164("19012200869")).toBe("+19012200869");
  });

  it("strips letters and punctuation defensively", () => {
    expect(toE164("call 901-220.0869 anytime")).toBe("+19012200869");
  });
});

describe("isPlausibleUsPhone", () => {
  it("accepts valid US shapes", () => {
    expect(isPlausibleUsPhone("9012200869")).toBe(true);
    expect(isPlausibleUsPhone("(901) 220-0869")).toBe(true);
    expect(isPlausibleUsPhone("+1 901-220-0869")).toBe(true);
    expect(isPlausibleUsPhone("19012200869")).toBe(true);
  });

  it("rejects short / empty / null", () => {
    expect(isPlausibleUsPhone("")).toBe(false);
    expect(isPlausibleUsPhone(null)).toBe(false);
    expect(isPlausibleUsPhone(undefined)).toBe(false);
    expect(isPlausibleUsPhone("12345")).toBe(false);
  });

  it("rejects non-US-length numbers (defensive — caller decides)", () => {
    expect(isPlausibleUsPhone("44 20 7946 0958")).toBe(false); // UK 12 digits
  });
});
