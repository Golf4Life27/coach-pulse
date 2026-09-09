import { describe, it, expect } from "vitest";
import { normalizeForGsm7, estimateSmsSegments, findNonGsm7Chars } from "./gsm7";
import { IDENTITY_QUESTION_STANDING_ANSWER } from "@/lib/standing-answers";

describe("normalizeForGsm7", () => {
  it("maps em dash, en dash and figure dash to a plain hyphen", () => {
    expect(normalizeForGsm7("Yes—I buy with cash")).toBe("Yes-I buy with cash");
    expect(normalizeForGsm7("2020–2026")).toBe("2020-2026");
    expect(normalizeForGsm7("fig‒ure")).toBe("fig-ure");
  });

  it("maps curly single/double quotes to straight equivalents", () => {
    expect(normalizeForGsm7("you’re")).toBe("you're");
    expect(normalizeForGsm7("‘quoted’")).toBe("'quoted'");
    expect(normalizeForGsm7("“quoted”")).toBe('"quoted"');
  });

  it("maps ellipsis to three periods", () => {
    expect(normalizeForGsm7("wait…")).toBe("wait...");
  });

  it("maps non-breaking space and narrow no-break space to a regular space", () => {
    expect(normalizeForGsm7("a\u00A0b")).toBe("a b");
    expect(normalizeForGsm7("a\u202Fb")).toBe("a b");
  });

  it("leaves plain ASCII text untouched", () => {
    const plain = "Happy to send the POF over now. Call me at (815) 556-9965.";
    expect(normalizeForGsm7(plain)).toBe(plain);
  });

  it("does not change wording — only the offending characters", () => {
    const withSmartChars = "Proof of funds — sent today… that’s the plan.";
    const normalized = normalizeForGsm7(withSmartChars);
    expect(normalized).toBe("Proof of funds - sent today... that's the plan.");
    // Same words, same order — every letter survives untouched.
    const words = (s: string) => s.match(/[a-z]+/gi);
    expect(words(normalized)).toEqual(words(withSmartChars));
  });
});

describe("estimateSmsSegments", () => {
  it("a plain ASCII message under 160 chars is GSM-7, 1 segment", () => {
    const r = estimateSmsSegments("Thanks for getting back to me. I'll follow up shortly.");
    expect(r.encoding).toBe("gsm7");
    expect(r.segments).toBe(1);
  });

  it("one em dash forces the WHOLE message to UCS-2", () => {
    const withDash = "Proof of funds — sent today.";
    const r = estimateSmsSegments(withDash);
    expect(r.encoding).toBe("ucs2");
    expect(r.units).toBe(withDash.length);
  });

  it("normalizing the em dash away brings it back to GSM-7", () => {
    const withDash = "Proof of funds — sent today.";
    const r = estimateSmsSegments(normalizeForGsm7(withDash));
    expect(r.encoding).toBe("gsm7");
  });

  it("GSM-7 single segment holds up to 160 units, then splits at 153/segment", () => {
    const exactly160 = "x".repeat(160);
    expect(estimateSmsSegments(exactly160)).toEqual({ encoding: "gsm7", units: 160, segments: 1 });
    const oneOver = "x".repeat(161);
    expect(estimateSmsSegments(oneOver)).toEqual({ encoding: "gsm7", units: 161, segments: 2 });
    const threeSegments = "x".repeat(307); // 153*2 + 1
    expect(estimateSmsSegments(threeSegments).segments).toBe(3);
  });

  it("UCS-2 single segment holds up to 70 units, then splits at 67/segment", () => {
    const nonGsm7 = "α"; // Greek lowercase alpha — one UTF-16 unit, outside GSM-7 -> forces UCS-2
    const exactly70 = nonGsm7 + "x".repeat(69);
    expect(estimateSmsSegments(exactly70)).toEqual({ encoding: "ucs2", units: 70, segments: 1 });
    const oneOver = nonGsm7 + "x".repeat(70);
    expect(estimateSmsSegments(oneOver)).toEqual({ encoding: "ucs2", units: 71, segments: 2 });
  });

  it("a surrogate-pair character (e.g. an emoji) bills as 2 UCS-2 units, matching real carrier billing", () => {
    const emoji = "\u{1F600}"; // outside GSM-7, 2 UTF-16 code units
    const r = estimateSmsSegments(emoji);
    expect(r.encoding).toBe("ucs2");
    expect(r.units).toBe(2);
  });

  it("GSM-7 extension characters (^{}\\[~]|€) cost 2 units each", () => {
    const r = estimateSmsSegments("{}");
    expect(r.encoding).toBe("gsm7");
    expect(r.units).toBe(4);
  });

  it("empty string is zero units, zero segments", () => {
    expect(estimateSmsSegments("")).toEqual({ encoding: "gsm7", units: 0, segments: 0 });
  });

  // Regression: the operator-approved identity-question standing answer must
  // stay GSM-7 and bill 3 segments. v1 (273 chars, one em-dash) billed 5
  // segments as UCS-2; v2 (361 chars, plain hyphen) bills 3 as GSM-7 — more
  // text, fewer segments, because it never left the 7-bit alphabet.
  it("the identity-question standing answer is GSM-7, 3 segments", () => {
    const r = estimateSmsSegments(IDENTITY_QUESTION_STANDING_ANSWER);
    expect(r.encoding).toBe("gsm7");
    expect(r.segments).toBe(3);
  });
});

describe("the denylist holes that shipped (2026-09-09)", () => {
  it("normalizes the middle dot, which forced UCS-2 straight past the choke point", () => {
    expect(normalizeForGsm7("a \u00B7 b")).toBe("a - b");
  });

  it("normalizes the rightwards arrow, which was live in the reply-alert scope line", () => {
    expect(normalizeForGsm7("rehab $40,000 \u2192 ceiling $50,000")).toBe(
      "rehab $40,000 -> ceiling $50,000",
    );
  });

  it("findNonGsm7Chars reports nothing once a smart body is normalized", () => {
    const dirty = "Yes\u2014I buy cash\u00B7 rehab \u2192 ceiling\u2026 \u201Cas-is\u201D";
    expect(findNonGsm7Chars(dirty).length).toBeGreaterThan(0);
    expect(findNonGsm7Chars(normalizeForGsm7(dirty))).toEqual([]);
    expect(estimateSmsSegments(normalizeForGsm7(dirty)).encoding).toBe("gsm7");
  });

  it("findNonGsm7Chars names the offender rather than failing silently", () => {
    expect(findNonGsm7Chars("plain ascii")).toEqual([]);
    expect(findNonGsm7Chars("emoji \u{1F600}").length).toBeGreaterThan(0);
  });
});
