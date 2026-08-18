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
    // 5-year balloon default: full payoff would run ~228mo, so the seller is
    // fully paid at month 60 — payments plus the remaining balance.
    expect(r.termMonths).toBe(cfg.balloonMonths);
    expect(r.payoffMonths).toBeGreaterThan(cfg.balloonMonths);
    expect(r.balloonAmount).toBe(r.price - r.downPayment - r.monthlyPayment * cfg.balloonMonths);
    // Refi-exit gate honored: balloon inside 70% of the ARV basis.
    expect(r.balloonAmount).toBeLessThanOrEqual(Math.round(hadley.arvBasis! * cfg.balloonRefiLtvMax));
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

  it("HOLDs when the balloon balance exceeds the buyer's plausible refi exit", () => {
    // High price on modest rent: at month 60 the balance ($189,000) sits above
    // 70% of the value basis — a balloon the buyer can't survive is never sent.
    const r = priceSellerFinance(
      { listPrice: 240000, monthlyRent: 1100, arvBasis: 245000, arvSource: "own_comps", wholesaleFee: 5000 },
      cfg,
    );
    expect(r.verdict).toBe("hold");
    if (r.verdict !== "hold") return;
    expect(r.reason).toBe("balloon_refi_too_heavy");
  });

  it("carries NO balloon when the payoff amortizes inside the balloon window", () => {
    // Strong rent on cheap stock: payment $500/mo retires the principal fast.
    const r = priceSellerFinance(
      { listPrice: 30000, monthlyRent: 1350, arvBasis: 32000, arvSource: "own_comps", wholesaleFee: 2000 },
      cfg,
    );
    expect(r.verdict).toBe("sendable_terms");
    if (r.verdict !== "sendable_terms") return;
    expect(r.payoffMonths).toBeLessThanOrEqual(cfg.balloonMonths);
    expect(r.termMonths).toBe(r.payoffMonths);
    expect(r.balloonAmount).toBe(0);
  });

  it("never prices above the value cap regardless of ask", () => {
    const r = priceSellerFinance({ ...hadley, listPrice: 400000, monthlyRent: 2400, arvBasis: 90000 }, cfg);
    if (r.verdict === "sendable_terms") {
      expect(r.price).toBeLessThanOrEqual(90250); // round250(90000×1.0)
    }
  });
});
