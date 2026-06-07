// @agent: orchestrator — input-integrity guard at ingestion.
// "CMA/operator inputs are operator-supplied figures verbatim or rejected
//  — prose never converts to numbers." (operator brief 2026-06-07)
import { describe, it, expect } from "vitest";
import { parseOperatorFigure } from "./operator-input";

describe("parseOperatorFigure — accepts clean verbatim operator figures", () => {
  it("bare integer", () => {
    const r = parseOperatorFigure("22000", "int");
    expect(r).toMatchObject({ ok: true, value: 22000, supplied: true, reason: null });
  });
  it("dollar sign + thousands commas", () => {
    expect(parseOperatorFigure("$22,000", "int").value).toBe(22000);
    expect(parseOperatorFigure("$132,675", "int").value).toBe(132675);
    expect(parseOperatorFigure("1,234,567", "int").value).toBe(1234567);
  });
  it("surrounding whitespace is trimmed", () => {
    expect(parseOperatorFigure("  37073  ", "int").value).toBe(37073);
  });
  it("float kind accepts a decimal (ppsf)", () => {
    expect(parseOperatorFigure("87.5", "float").value).toBe(87.5);
    expect(parseOperatorFigure("$93.25", "float").value).toBe(93.25);
  });
  it("absent input is not an error — supplied:false, value:null", () => {
    for (const v of [null, undefined, "", "   "]) {
      const r = parseOperatorFigure(v as string | null, "int");
      expect(r.ok).toBe(true);
      expect(r.supplied).toBe(false);
      expect(r.value).toBeNull();
    }
  });
});

describe("parseOperatorFigure — REJECTS prose; never coerces to a number", () => {
  // The exact incident class: the bug value leaked from a prose render
  // ("rehab $16k mid / $22k high photo-informed"). Every prose-shaped token
  // here MUST reject (ok:false, value:null) — not silently parse to a partial.
  const proseTokens = [
    "22k",
    "22K",
    "$22k high",
    "$16k mid / $22k high",
    "$22,000 photo-informed",
    "22000 photo-informed",
    "twenty-two thousand",
    "~22000",
    "22000ish",
    "22-37k",
    "1,23,456", // malformed thousands grouping
    "22,00", // malformed grouping
    "-5000", // negative price
    "1e5", // scientific
    "$", // currency sign only
    "N/A",
    "high end of band",
  ];
  for (const tok of proseTokens) {
    it(`rejects "${tok}"`, () => {
      const r = parseOperatorFigure(tok, "int");
      expect(r.ok).toBe(false);
      expect(r.value).toBeNull();
      expect(r.supplied).toBe(true);
      expect(r.reason).toBeTruthy();
    });
  }
  it("int kind rejects a decimal (rehab/ARV are whole dollars)", () => {
    const r = parseOperatorFigure("22000.5", "int");
    expect(r.ok).toBe(false);
    expect(r.value).toBeNull();
  });
});

describe("REGRESSION PIN — the cma_rehab_high=$22,000 incident", () => {
  it("a clean operator-typed $22,000 IS accepted (the parser is not the gatekeeper of intent — verbatim-ness is)", () => {
    // The figure itself is well-formed; the defect was provenance (supplied
    // by no one) + the inversion. This parser's job is narrower but firm:
    // only verbatim numbers pass, and every accept carries the raw token so
    // the caller can audit WHAT was supplied.
    const r = parseOperatorFigure("$22,000", "int");
    expect(r).toMatchObject({ ok: true, value: 22000, raw: "$22,000", supplied: true });
  });
  it("the prose it actually leaked from is REJECTED at ingestion", () => {
    // Had the override been passed as the verbatim prose it came from, the
    // guard refuses it outright instead of coercing "22" or "22000".
    for (const prose of ["$22k high photo-informed", "rehab high $22k", "22k (photo)"]) {
      const r = parseOperatorFigure(prose, "int");
      expect(r.ok).toBe(false);
      expect(r.value).toBeNull();
    }
  });
});
