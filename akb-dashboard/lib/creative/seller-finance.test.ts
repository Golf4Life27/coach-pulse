import { describe, expect, it } from "vitest";
import {
  priceSellerFinance,
  readSellerFinanceConfig,
  type SellerFinanceInput,
} from "./seller-finance";

const cfg = readSellerFinanceConfig({}); // defaults, env-independent

const hadley: SellerFinanceInput = {
  // 3470 Hadley Ave, Youngstown 44505 — the BBC Deal Checker worked example
  // and the lane's first live case (spine reclGWrXeJIy0u7ER). Ask $95,000,
  // RentCast rent $905/mo, 44505 seed ARV 972 sqft × $91/psf ≈ $88,452.
  listPrice: 95000,
  monthlyRent: 905,
  arvBasis: 88452,
  arvSource: "seed_renovated",
  wholesaleFee: 5000,
};

describe("priceSellerFinance — the Hadley worked example", () => {
  it("produces the BBC-shaped offer with our value cap engaged", () => {
    const r = priceSellerFinance(hadley, cfg);
    expect(r.verdict).toBe("sendable_terms");
    if (r.verdict !== "sendable_terms") return;
    // Value cap: seed ARV $88,452 < ask $95,000 → price capped, never above value.
    expect(r.priceCappedToValue).toBe(true);
    expect(r.price).toBe(88500); // round250(88452)=88500 ≤ round250(95000)
    // Payment matches BBC's calculator to the dollar: $350/mo.
    expect(r.monthlyPayment).toBe(350);
    // Principal-only term inside 30y; no balloon.
    expect(r.termMonths).toBeLessThanOrEqual(cfg.termMaxMonths);
    // Buyer economics clear both floors.
    expect(r.buyerMonthlyCashflow).toBeGreaterThanOrEqual(cfg.cashflowFloorUsd);
    expect(r.buyerCashOnCash).toBeGreaterThanOrEqual(cfg.cocMin);
    // Entry stays inside the ceiling and includes the fee.
    expect(r.entryPct).toBeLessThanOrEqual(cfg.entryPctMax);
    expect(r.totalEntry).toBe(r.downPayment + r.wholesaleFee + r.closingCosts);
  });

  it("offers full ask when the value basis supports it", () => {
    const r = priceSellerFinance({ ...hadley, arvBasis: 135000 }, cfg);
    expect(r.verdict).toBe("sendable_terms");
    if (r.verdict !== "sendable_terms") return;
    expect(r.priceCappedToValue).toBe(false);
    expect(r.price).toBe(95000);
  });
});

describe("priceSellerFinance — holds, never guesses", () => {
  it("HOLDs without a rent estimate (machine-fixable, auto_rent)", () => {
    const r = priceSellerFinance({ ...hadley, monthlyRent: null }, cfg);
    expect(r.verdict).toBe("hold");
    if (r.verdict !== "hold") return;
    expect(r.reason).toBe("no_rent_estimate");
    expect(r.automatable).toBe(true);
  });

  it("HOLDs without a trusted ARV basis — a terms price is still a price", () => {
    const r = priceSellerFinance({ ...hadley, arvBasis: null, arvSource: "none" }, cfg);
    expect(r.verdict).toBe("hold");
    if (r.verdict !== "hold") return;
    expect(r.reason).toBe("no_value_basis");
  });

  it("HOLDs when rent cannot carry any payment", () => {
    const r = priceSellerFinance({ ...hadley, monthlyRent: 260 }, cfg);
    expect(r.verdict).toBe("hold");
    if (r.verdict !== "hold") return;
    expect(r.reason).toBe("rent_too_thin");
  });

  it("HOLDs when fee + closing break the entry ceiling on cheap stock", () => {
    // $18k house: fee $5,000 + closing dominate — no room for a real down.
    const r = priceSellerFinance(
      { listPrice: 18000, monthlyRent: 750, arvBasis: 20000, arvSource: "seed_renovated", wholesaleFee: 5000 },
      cfg,
    );
    expect(r.verdict).toBe("hold");
    if (r.verdict !== "hold") return;
    expect(r.reason).toBe("entry_too_heavy");
  });

  it("HOLDs for a balloon when principal cannot amortize inside the term cap", () => {
    // High price on modest rent: payment tops out, term blows past 360.
    const r = priceSellerFinance(
      { listPrice: 240000, monthlyRent: 1100, arvBasis: 245000, arvSource: "own_comps", wholesaleFee: 5000 },
      cfg,
    );
    expect(r.verdict).toBe("hold");
    if (r.verdict !== "hold") return;
    expect(r.reason).toBe("needs_balloon");
  });

  it("never prices above the value cap regardless of ask", () => {
    const r = priceSellerFinance({ ...hadley, listPrice: 400000, monthlyRent: 2400, arvBasis: 90000 }, cfg);
    if (r.verdict === "sendable_terms") {
      expect(r.price).toBeLessThanOrEqual(90250); // round250(90000×1.0)
    }
  });
});
