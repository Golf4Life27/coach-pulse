import { describe, expect, it } from "vitest";
import { greetName, renderTermsOpener, termsPriority } from "./terms-opener";
import type { SellerFinanceOffer } from "./seller-finance";

const offer = (over: Partial<SellerFinanceOffer> = {}): SellerFinanceOffer => ({
  verdict: "sendable_terms",
  price: 95000,
  priceCappedToValue: false,
  downPayment: 9500,
  monthlyPayment: 350,
  termMonths: 60,
  payoffMonths: 245,
  balloonAmount: 64500,
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
    // Offer sentence is operator-authored verbatim (2026-08-18, wiggle-room
    // clause added 2026-08-19) — pin it whole.
    expect(msg).toContain(
      "Assuming the numbers hold, I can offer the full $95,000 asking price seller-financed. $9,500 at closing, then $350/month until the full amount is paid.",
    );
    expect(msg).toContain("Hi Erica —");
  });

  it("names OUR number instead when the price was value-capped", () => {
    const msg = renderTermsOpener({
      agentName: "Diana",
      address: "150 W Hildale",
      listPrice: 257000,
      offer: offer({ price: 108500, priceCappedToValue: true }),
    });
    expect(msg).toContain("Assuming the numbers hold, I can offer $108,500 seller-financed");
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
      expect(msg).toContain("until the full amount is paid");
    }
  });

  it("conditions the NUMBER pre-contract in both variants, and never stacks a second hedge (operator 2026-08-19)", () => {
    for (const capped of [true, false]) {
      const msg = renderTermsOpener({ agentName: "A B", address: "X", listPrice: 1, offer: offer({ priceCappedToValue: capped }) });
      // The clause sits before the price so an adjustment is contemplated, not a retrade.
      expect(msg).toContain("Assuming the numbers hold, I can offer");
      // Contract-stage contingency language would push discovery into escrow —
      // wasted time and effort. Pre-contract conditioning only.
      expect(msg).not.toMatch(/subject to|contingent (up)?on|pending inspection/i);
    }
  });

  // Cap raised 420 → 450 on 2026-08-19 to fund the operator's wiggle-room
  // clause (+27 chars). Deliberate, not drift: 450 is still ~3 SMS segments,
  // and the alternative was cutting meaning out of an operator-authored line.
  it("stays text-sized (operator length directive 2026-08-18): under 450 chars on realistic inputs", () => {
    const msg = renderTermsOpener({
      agentName: "Lakesha \"Lilly\" Leatherwood",
      address: "759 Brandywine Blvd, Memphis, TN 38127",
      listPrice: 128500,
      offer: offer({ price: 128500, downPayment: 12850, monthlyPayment: 425 }),
    });
    expect(msg.length).toBeLessThan(450);
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
