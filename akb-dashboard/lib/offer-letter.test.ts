import { describe, it, expect } from "vitest";
import {
  assembleOfferLetter,
  renderOfferLetterHtml,
  priceInWords,
  integerToWords,
  formatMoney,
  priceBasisFlagged,
  addBusinessDays,
  formatPropertyAddress,
  DEFAULT_EMD,
  DEFAULT_CLOSE_DAYS,
  INSPECTION_PERIOD_DAYS,
} from "./offer-letter";

const BASE = {
  address: "927 Avon St",
  city: "Memphis",
  state: "TN",
  zip: "38107",
  now: new Date("2026-07-20T12:00:00Z"), // a Monday
};

describe("price formatting + words", () => {
  it("renders whole dollars without cents", () => {
    expect(formatMoney(85000)).toBe("$85,000");
    expect(formatMoney(1000)).toBe("$1,000");
    expect(formatMoney(1234567)).toBe("$1,234,567");
  });

  it("renders cents when present", () => {
    expect(formatMoney(85000.5)).toBe("$85,000.50");
  });

  it("converts integers to title-case words", () => {
    expect(integerToWords(0)).toBe("Zero");
    expect(integerToWords(15)).toBe("Fifteen");
    expect(integerToWords(85)).toBe("Eighty-Five");
    expect(integerToWords(105)).toBe("One Hundred Five");
    expect(integerToWords(85000)).toBe("Eighty-Five Thousand");
    expect(integerToWords(121500)).toBe("One Hundred Twenty-One Thousand Five Hundred");
    expect(integerToWords(1000000)).toBe("One Million");
    expect(integerToWords(2345678)).toBe(
      "Two Million Three Hundred Forty-Five Thousand Six Hundred Seventy-Eight",
    );
  });

  it("renders the legal long form with cents", () => {
    expect(priceInWords(85000)).toBe("Eighty-Five Thousand and 00/100 Dollars");
    expect(priceInWords(1000)).toBe("One Thousand and 00/100 Dollars");
    expect(priceInWords(85000.5)).toBe("Eighty-Five Thousand and 50/100 Dollars");
  });
});

describe("address + dates", () => {
  it("joins address parts", () => {
    expect(formatPropertyAddress(BASE)).toBe("927 Avon St, Memphis, TN 38107");
    expect(formatPropertyAddress({ address: "1 Main St" })).toBe("1 Main St");
  });

  it("skips weekends when adding business days", () => {
    // Mon 2026-07-20 + 5 business days = Mon 2026-07-27
    expect(addBusinessDays(new Date("2026-07-20T12:00:00Z"), 5).toISOString().slice(0, 10)).toBe(
      "2026-07-27",
    );
  });
});

describe("price source resolution", () => {
  it("prefers the stored rough opener", () => {
    const r = assembleOfferLetter({ ...BASE, roughOpenerAmount: 61000, outreachOfferPrice: 58000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.offerPrice).toBe(61000);
    expect(r.data.priceSource).toBe("rough_opener");
  });

  it("falls back to outreachOfferPrice", () => {
    const r = assembleOfferLetter({ ...BASE, roughOpenerAmount: null, outreachOfferPrice: 58000 });
    expect(r.ok && r.data.priceSource).toBe("outreach_offer_price");
    expect(r.ok && r.data.offerPrice).toBe(58000);
  });

  it("lets an explicit operator override win", () => {
    const r = assembleOfferLetter({ ...BASE, roughOpenerAmount: 61000, priceOverride: 72500 });
    expect(r.ok && r.data.priceSource).toBe("override");
    expect(r.ok && r.data.offerPriceFigures).toBe("$72,500");
  });

  it("REFUSES with 422 when there is no stored number and no override", () => {
    const r = assembleOfferLetter({ ...BASE, roughOpenerAmount: null, outreachOfferPrice: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.error).toBe("no_offer_price");
    expect(r.message).toMatch(/will not compute or invent a number/i);
  });

  it("treats zero / negative / non-finite stored numbers as absent (never invents)", () => {
    for (const bad of [0, -1, NaN] as number[]) {
      const r = assembleOfferLetter({ ...BASE, roughOpenerAmount: bad, outreachOfferPrice: bad });
      expect(r.ok).toBe(false);
    }
  });
});

describe("defaults + overrides", () => {
  it("defaults EMD, closing window, inspection period", () => {
    const r = assembleOfferLetter({ ...BASE, roughOpenerAmount: 61000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.emd).toBe(DEFAULT_EMD);
    expect(r.data.closeDays).toBe(DEFAULT_CLOSE_DAYS);
    expect(r.data.inspectionDays).toBe(INSPECTION_PERIOD_DAYS);
    expect(r.data.inspectionDays).toBe(10);
  });

  it("honors emd + close_days overrides", () => {
    const r = assembleOfferLetter({ ...BASE, roughOpenerAmount: 61000, emd: 2500, closeDays: 21 });
    expect(r.ok && r.data.emdFigures).toBe("$2,500");
    expect(r.ok && r.data.closeDays).toBe(21);
  });
});

describe("safety banner logic", () => {
  it("flags renovatedLanguage === true", () => {
    expect(priceBasisFlagged({ renovatedLanguage: true })).toBe(true);
  });

  it("flags a SIZE-EXTRAPOLATION REVIEW note", () => {
    expect(priceBasisFlagged({ notes: "2026-07-23 SIZE-EXTRAPOLATION REVIEW — subject 2,400sf" })).toBe(true);
  });

  it("does not flag a clean record", () => {
    expect(priceBasisFlagged({ renovatedLanguage: false, notes: "agent asked for it in writing" })).toBe(false);
    expect(priceBasisFlagged({})).toBe(false);
  });

  it("renders the banner screen-only and hides it in print", () => {
    const r = assembleOfferLetter({ ...BASE, roughOpenerAmount: 61000, renovatedLanguage: true });
    expect(r.ok && r.data.flagged).toBe(true);
    if (!r.ok) return;
    const html = renderOfferLetterHtml(r.data);
    expect(html).toContain("PRICE BASIS FLAGGED");
    expect(html).toContain('class="screen-only warn"');
    expect(html).toMatch(/@media print[\s\S]*\.screen-only\s*\{\s*display:\s*none/);
  });

  it("omits the banner entirely on a clean record", () => {
    const r = assembleOfferLetter({ ...BASE, roughOpenerAmount: 61000, notes: "clean" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = renderOfferLetterHtml(r.data);
    expect(html).not.toContain("PRICE BASIS FLAGGED");
  });
});

describe("rendered letter body — doctrine", () => {
  const built = assembleOfferLetter({
    ...BASE,
    roughOpenerAmount: 85000,
    agentName: "Jane Doe",
    renovatedLanguage: true,
    notes: "SIZE-EXTRAPOLATION REVIEW",
  });
  if (!built.ok) throw new Error("fixture should assemble");
  const html = renderOfferLetterHtml(built.data);
  const flat = html.replace(/\s+/g, " ");

  it("NEVER contains the word 'assignable' anywhere in the full rendered body", () => {
    expect(html.toLowerCase()).not.toContain("assignable");
    expect(html.toLowerCase()).not.toContain("assignment");
  });

  it("never leaks internal math vocabulary into the letter body", () => {
    // The screen-only operator banner may name the flagged basis; the LETTER
    // (everything inside .sheet, i.e. what prints) may not.
    const letterBody = html.slice(html.indexOf('<div class="sheet">'));
    const lower = letterBody.toLowerCase();
    for (const word of ["arv", "rehab", "spread", "wholesale", "assignment fee", "profit margin"]) {
      expect(lower).not.toContain(word);
    }
  });

  it("states the price in both words and figures", () => {
    expect(html).toContain("Eighty-Five Thousand and 00/100 Dollars");
    expect(html).toContain("$85,000");
  });

  it("carries the required terms", () => {
    expect(html).toContain("AKB Solutions LLC and/or affiliated entities");
    expect(html).toContain("All cash");
    expect(html).toContain("No financing contingency");
    expect(html).toContain("as-is, where-is");
    expect(flat).toContain("10 days from the date of acceptance");
    expect(flat).toContain("On or before a date of the seller&rsquo;s choosing, up to 30 days from acceptance");
    expect(html).toContain("5 business days");
    expect(html).toContain("Alex Balog");
    expect(html).toContain("(815) 556-9965");
    expect(html).toContain("alex@akb-properties.com");
    expect(html).toContain("927 Avon St, Memphis, TN 38107");
    expect(html).toContain("Dear Jane Doe:");
  });

  it("says it is not a contract", () => {
    expect(html).toContain("is not a binding purchase contract");
  });

  it("is a printable letter-size document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("@page { size: letter;");
  });

  it("greets generically when no agent name is known", () => {
    const r = assembleOfferLetter({ ...BASE, roughOpenerAmount: 85000, agentName: "  " });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renderOfferLetterHtml(r.data)).toContain("To the Listing Agent:");
  });
});
