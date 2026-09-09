import { describe, it, expect } from "vitest";
import { IDENTITY_QUESTION_STANDING_ANSWER } from "./standing-answers";
import { estimateSmsSegments } from "./sms/gsm7";

// GSM 03.38 basic + extension alphabet, duplicated here (rather than imported)
// so this guard fails even if lib/sms/gsm7.ts's own alphabet were ever
// loosened — the point is an independent check on the fixed text.
const GSM7_CHARS =
  "@£$¥èéùìòÇ\nØø\rÅå" +
  "Δ_ΦΓΛΩΠΨΣΘΞ" +
  "ÆæßÉ" +
  " !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§" +
  "¿abcdefghijklmnopqrstuvwxyzäöñüà" +
  "^{}\\[~]|€";
const GSM7_SET = new Set(GSM7_CHARS);

describe("IDENTITY_QUESTION_STANDING_ANSWER — the fixed operator text", () => {
  it("contains no character outside the GSM-7 alphabet (guards against a re-introduced smart character)", () => {
    for (const ch of IDENTITY_QUESTION_STANDING_ANSWER) {
      expect(GSM7_SET.has(ch)).toBe(true);
    }
  });

  it("bills as GSM-7, 3 segments", () => {
    const r = estimateSmsSegments(IDENTITY_QUESTION_STANDING_ANSWER);
    expect(r.encoding).toBe("gsm7");
    expect(r.segments).toBe(3);
  });

  it("carries no em dash, en dash, or curly quote (plain ASCII hyphen and apostrophe only)", () => {
    expect(IDENTITY_QUESTION_STANDING_ANSWER).not.toMatch(/[—–‒‘’“”…]/);
  });

  it("names no commission percentage — we have not read their listing agreement", () => {
    // No digit immediately followed by a percent sign ("6%", "3.5%", ...).
    expect(IDENTITY_QUESTION_STANDING_ANSWER).not.toMatch(/\d\s*%/);
    // No standalone "N%"-shaped commission token anywhere in the text.
    expect(IDENTITY_QUESTION_STANDING_ANSWER).not.toMatch(/\b\d+(?:\.\d+)?%/);
  });

  it("claims no track record — AKB has closed zero deals to date", () => {
    const lower = IDENTITY_QUESTION_STANDING_ANSWER.toLowerCase();
    expect(lower).not.toMatch(/we'?ve closed/);
    expect(lower).not.toMatch(/closed dozens/);
    expect(lower).not.toMatch(/all the time/);
    expect(lower).not.toMatch(/track record/);
    expect(lower).not.toMatch(/\bexperience\b/);
  });

  it("still discloses assignment on purpose (the operator's deliberate design)", () => {
    expect(IDENTITY_QUESTION_STANDING_ANSWER.toLowerCase()).toMatch(/assign/);
  });
});
