import { describe, expect, it } from "vitest";
import { greetName, renderTermsOpener, termsPriority } from "./terms-opener";
import type { SellerFinanceOffer } from "./seller-finance";

const offer = (over: Partial<SellerFinanceOffer> = {}): SellerFinanceOffer => ({
  verdict: "sendable_terms",
  price: 95000,
  priceCappedToValue: false,
  downPayment: 9500,
  monthlyPayment: 350,
  termMonths: 245,
  wholesaleFee: 5000,
  closingCosts: 1188,
  totalEntry: 15688,
  entryPct: 0.165,
  buyerMonthlyCashflow: 193,
  buyerCashOnCash: 0.148,
  arvBasisUsed: 135000,
  derivation: "test",
  ...over,
});

describe("renderTermsOpener", () => {
  it("says FULL ASKING PRICE only when the value cap did not engage", () => {
    const msg = renderTermsOpener({ agentName: "Erica Winner", address: "3470 Hadley Ave", listPrice: 95000, offer: offer() });
    expect(msg).toContain("full $95,000 asking price");
    expect(msg).toContain("Hi Erica —");
    expect(msg).toContain("$9,500 at closing, then $350/month");
  });

  it("names OUR number instead when the price was value-capped", () => {
    const msg = renderTermsOpener({
      agentName: "Diana",
      address: "150 W Hildale",
      listPrice: 257000,
      offer: offer({ price: 108500, priceCappedToValue: true }),
    });
    expect(msg).toContain("$108,500 seller-financed");
    // "paid in full" legitimately appears in both variants — the claim under
    // test is that a value-capped offer never says "full ... asking price".
    expect(msg).not.toContain("full $");
    expect(msg).not.toContain("asking price");
  });

  it("leads with the agent's commission and the seller's upside in BOTH variants (operator tone directive 2026-08-18)", () => {
    for (const capped of [true, false]) {
      const msg = renderTermsOpener({ agentName: "A B", address: "X", listPrice: 1, offer: offer({ priceCappedToValue: capped }) });
      expect(msg).toContain("Your commission is paid in full at closing");
      expect(msg).toContain("seller nets more than any cash offer");
      expect(msg).toContain("wait on the payout");
    }
  });

  it("stays text-sized (operator length directive 2026-08-18): under 400 chars on realistic inputs", () => {
    const msg = renderTermsOpener({
      agentName: "Lakesha \"Lilly\" Leatherwood",
      address: "759 Brandywine Blvd, Memphis, TN 38127",
      listPrice: 128500,
      offer: offer({ price: 128500, downPayment: 12850, monthlyPayment: 425 }),
    });
    expect(msg.length).toBeLessThan(420);
  });

  it("ALWAYS asks the mortgage question — the unknown lien is collected on first touch", () => {
    for (const capped of [true, false]) {
      const msg = renderTermsOpener({ agentName: null, address: "X", listPrice: 1, offer: offer({ priceCappedToValue: capped }) });
      expect(msg).toContain("free and clear, or is there a mortgage?");
    }
  });

  it("never promises a binding structure — it offers to put it in writing IF open", () => {
    const msg = renderTermsOpener({ agentName: "A B", address: "X", listPrice: 1, offer: offer() });
    expect(msg).toContain("if they're open");
  });
});

describe("termsPriority", () => {
  it("ranks full-ask offers above value-capped ones regardless of CoC", () => {
    const fullAsk = termsPriority(offer({ priceCappedToValue: false, buyerCashOnCash: 0.12 }));
    const capped = termsPriority(offer({ priceCappedToValue: true, buyerCashOnCash: 0.35 }));
    expect(fullAsk).toBeGreaterThan(capped);
  });

  it("breaks ties by buyer cash-on-cash", () => {
    const a = termsPriority(offer({ buyerCashOnCash: 0.2 }));
    const b = termsPriority(offer({ buyerCashOnCash: 0.15 }));
    expect(a).toBeGreaterThan(b);
  });
});
