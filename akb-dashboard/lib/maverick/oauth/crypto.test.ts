// @agent: maverick — OAuth crypto primitives tests.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  base64url,
  constantTimeEqual,
  generateFamilyId,
  generateOpaqueToken,
  isValidCodeVerifier,
  verifyPkce,
} from "./crypto";

describe("base64url", () => {
  it("strips padding + maps + / → - _", () => {
    expect(base64url(Buffer.from("hello world!"))).not.toMatch(/[+/=]/);
  });
  it("round-trips through standard base64 with the URL-safe substitutions", () => {
    const buf = Buffer.from([255, 254, 253, 252]);
    const s = base64url(buf);
    // 255,254,253,252 → standard b64 "//79/A==" → url-safe "__79_A"
    expect(s).toBe("__79_A");
  });
});

describe("verifyPkce — S256", () => {
  it("returns true for a verifier whose SHA-256 base64url matches the challenge", () => {
    const verifier = "abc123" + "x".repeat(45); // 51 chars, valid range
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    expect(verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  it("returns false on a mismatched verifier", () => {
    const verifier = "abc123" + "x".repeat(45);
    const wrong = "wrong" + "y".repeat(46);
    const challenge = base64url(createHash("sha256").update(wrong).digest());
    expect(verifyPkce(verifier, challenge, "S256")).toBe(false);
  });

  it("returns false on non-string args (defensive)", () => {
    // @ts-expect-error - intentional bad input
    expect(verifyPkce(null, "x", "S256")).toBe(false);
    // @ts-expect-error - intentional bad input
    expect(verifyPkce("x", undefined, "S256")).toBe(false);
  });
});

describe("verifyPkce — plain", () => {
  it("returns true when verifier === challenge", () => {
    expect(verifyPkce("same", "same", "plain")).toBe(true);
  });
  it("returns false otherwise", () => {
    expect(verifyPkce("a", "b", "plain")).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("returns true on identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });
  it("returns false on different strings of same length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
  it("returns false on different lengths (bails before timingSafeEqual)", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
  it("returns false on non-string args", () => {
    // @ts-expect-error - intentional bad input
    expect(constantTimeEqual(null, "abc")).toBe(false);
    // @ts-expect-error - intentional bad input
    expect(constantTimeEqual("abc", 123)).toBe(false);
  });
});

describe("generateOpaqueToken", () => {
  it("preserves the prefix and has expected length", () => {
    const token = generateOpaqueToken("mat_");
    expect(token.startsWith("mat_")).toBe(true);
    // base64url(32 random bytes) = 43 chars (256 bits → 43 chars no padding)
    expect(token.length).toBe("mat_".length + 43);
  });
  it("generates unique values on each call", () => {
    const a = generateOpaqueToken("mat_");
    const b = generateOpaqueToken("mat_");
    expect(a).not.toBe(b);
  });
  it("contains no padding or unsafe chars", () => {
    const token = generateOpaqueToken("x_");
    expect(token).not.toMatch(/[+/=]/);
  });
});

describe("generateFamilyId", () => {
  it("prefixes with fam_ + base64url(16 bytes) = 22 chars", () => {
    const id = generateFamilyId();
    expect(id.startsWith("fam_")).toBe(true);
    expect(id.length).toBe(4 + 22);
  });
});

describe("isValidCodeVerifier", () => {
  it("accepts 43-char string of allowed chars", () => {
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
  });
  it("accepts 128-char string of allowed chars", () => {
    expect(isValidCodeVerifier("A1-._~".repeat(20) + "abcdefgh")).toBe(true);
  });
  it("rejects short strings (< 43)", () => {
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
  });
  it("rejects long strings (> 128)", () => {
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
  });
  it("rejects strings with disallowed chars", () => {
    expect(isValidCodeVerifier("a".repeat(42) + "!")).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isValidCodeVerifier(null)).toBe(false);
    expect(isValidCodeVerifier(42)).toBe(false);
    expect(isValidCodeVerifier({})).toBe(false);
  });
});
