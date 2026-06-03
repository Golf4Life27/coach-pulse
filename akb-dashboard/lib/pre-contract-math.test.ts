// @agent: orchestrator
// INV-023 pre-contract math gate tests (Spine recUS0oHqXLtEM3lG Track A).
//
// Anchor regressions the user locked as acceptance criteria:
//   1. 23 Fields at $61,750 vs $45K top buyer → BLOCKED
//   2. 1219 E Highland Blvd 78210 → Investor_MAO ≈ $90K
//
// Plus comprehensive coverage of the math + the hold/pass/block routing.

import { describe, it, expect } from "vitest";
import {
  computeInvestorMao,
  computeYourMao,
  evaluatePreContractMath,
  DEFAULT_WHOLESALE_FEE,
  DEFAULT_CMA_STALENESS_DAYS,
} from "./pre-contract-math";

const NOW = new Date("2026-06-02T12:00:00.000Z");

describe("computeInvestorMao", () => {
  it("returns Buyer_Median − Est_Rehab", () => {
    expect(computeInvestorMao(120_000, 30_000)).toBe(90_000);
    expect(computeInvestorMao(45_000, 10_000)).toBe(35_000);
  });

  it("allows zero rehab", () => {
    expect(computeInvestorMao(50_000, 0)).toBe(50_000);
  });

  it("returns negative when rehab exceeds Buyer_Median (the math is the math)", () => {
    expect(computeInvestorMao(40_000, 50_000)).toBe(-10_000);
  });

  it("returns null on missing / non-positive Buyer_Median", () => {
    expect(computeInvestorMao(null, 10_000)).toBeNull();
    expect(computeInvestorMao(undefined, 10_000)).toBeNull();
    expect(computeInvestorMao(0, 10_000)).toBeNull();
    expect(computeInvestorMao(-1, 10_000)).toBeNull();
    expect(computeInvestorMao(NaN, 10_000)).toBeNull();
  });

  it("returns null on missing / negative Est_Rehab (zero is valid)", () => {
    expect(computeInvestorMao(100_000, null)).toBeNull();
    expect(computeInvestorMao(100_000, undefined)).toBeNull();
    expect(computeInvestorMao(100_000, -1)).toBeNull();
    expect(computeInvestorMao(100_000, NaN)).toBeNull();
  });
});

describe("computeYourMao", () => {
  it("returns Investor_MAO − Wholesale_Fee", () => {
    expect(computeYourMao(90_000, 15_000)).toBe(75_000);
    expect(computeYourMao(35_000, 10_000)).toBe(25_000);
  });

  it("allows zero wholesale fee", () => {
    expect(computeYourMao(90_000, 0)).toBe(90_000);
  });

  it("returns null when Investor_MAO is null", () => {
    expect(computeYourMao(null, 15_000)).toBeNull();
  });

  it("returns null on negative wholesale fee", () => {
    expect(computeYourMao(90_000, -1)).toBeNull();
  });

  it("propagates a negative Investor_MAO into Your_MAO", () => {
    expect(computeYourMao(-10_000, 15_000)).toBe(-25_000);
  });
});

describe("evaluatePreContractMath — pass / hold / block aggregation", () => {
  it("PASS when every precondition is green", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: 60_000,
      buyerMedian: 120_000,
      estRehab: 30_000,
      cmaValidatedAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.status).toBe("pass");
    expect(r.cma.status).toBe("pass");
    expect(r.buyerMedian.status).toBe("pass");
    expect(r.mao.status).toBe("pass");
    expect(r.investorMao).toBe(90_000);
    expect(r.yourMao).toBe(85_000); // 90K − 5K default fee (Spine rec937cFJthvCZzBM)
  });

  it("HOLD when CMA is missing", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: 60_000,
      buyerMedian: 120_000,
      estRehab: 30_000,
      cmaValidatedAt: null,
      now: NOW,
    });
    expect(r.status).toBe("hold");
    expect(r.cma.status).toBe("hold");
    expect(r.cma.reason).toContain("CMA absent");
  });

  it("HOLD when CMA is stale (older than threshold)", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: 60_000,
      buyerMedian: 120_000,
      estRehab: 30_000,
      cmaValidatedAt: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.status).toBe("hold");
    expect(r.cma.status).toBe("hold");
    expect(r.cma.reason).toContain("stale");
  });

  it("HOLD when Buyer_Median is missing", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: 60_000,
      buyerMedian: null,
      estRehab: 30_000,
      cmaValidatedAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.status).toBe("hold");
    expect(r.buyerMedian.status).toBe("hold");
    expect(r.buyerMedian.reason).toContain("Buyer_Median absent");
  });

  it("HOLD when Est_Rehab is missing (math can't compute)", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: 60_000,
      buyerMedian: 120_000,
      estRehab: null,
      cmaValidatedAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.status).toBe("hold");
    expect(r.mao.status).toBe("hold");
    expect(r.mao.reason).toContain("Est_Rehab");
  });

  it("BLOCK when contract > Your_MAO (decisive math failure)", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: 100_000,
      buyerMedian: 120_000,
      estRehab: 30_000, // → investorMao 90K, yourMao 85K (5K default fee)
      cmaValidatedAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.status).toBe("block");
    expect(r.mao.status).toBe("block");
    expect(r.mao.reason).toContain("does not pass");
  });

  it("BLOCK when spread is negative (Your_MAO ≤ 0)", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: 50_000,
      buyerMedian: 40_000,
      estRehab: 20_000, // investorMao = 20K, yourMao = 5K
      wholesaleFee: 15_000,
      cmaValidatedAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.status).toBe("block");
  });

  it("block wins over hold when math is decisively negative even if CMA is missing", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: 100_000,
      buyerMedian: 50_000,
      estRehab: 10_000, // investorMao=40K, yourMao=35K (5K default fee) → 100K > 35K
      cmaValidatedAt: null, // CMA hold
      now: NOW,
    });
    expect(r.status).toBe("block");
    expect(r.cma.status).toBe("hold");
    expect(r.mao.status).toBe("block");
  });

  it("HOLD when contract price is unset (operator hasn't proposed terms yet)", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: null,
      buyerMedian: 120_000,
      estRehab: 30_000,
      cmaValidatedAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.status).toBe("hold");
    expect(r.mao.reason).toContain("Contract_Offer_Price unset");
  });

  it("uses DEFAULT_WHOLESALE_FEE when fee omitted", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: 60_000,
      buyerMedian: 120_000,
      estRehab: 30_000,
      cmaValidatedAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.wholesaleFeeUsed).toBe(DEFAULT_WHOLESALE_FEE);
  });

  it("uses DEFAULT_CMA_STALENESS_DAYS when threshold omitted", () => {
    const eightDaysAgo = new Date(NOW.getTime() - (DEFAULT_CMA_STALENESS_DAYS + 1) * 86_400_000).toISOString();
    const r = evaluatePreContractMath({
      contractOfferPrice: 60_000,
      buyerMedian: 120_000,
      estRehab: 30_000,
      cmaValidatedAt: eightDaysAgo,
      now: NOW,
    });
    expect(r.cma.status).toBe("hold");
  });
});

// ── ANCHOR REGRESSIONS (operator-locked acceptance criteria) ─────────────

describe("INV-023 anchor: 23 Fields at $61,750 vs $45k top buyer → BLOCK (Spine rec937cFJthvCZzBM: $5K fee)", () => {
  it("blocks contract advancement (Your_MAO = $20K at the locked $5K fee)", () => {
    // 23 Fields Ave (rec1HTUqK0YEVb7uA): operator under contract at
    // $61,750. Top buyer pays $45K (the Buyer_Median from InvestorBase
    // smart-match capped low). With $5K Wholesale_Fee (Spine
    // rec937cFJthvCZzBM): Investor_MAO=$25K, Your_MAO=$20K.
    // Contract $61,750 still wildly over → BLOCK.
    const r = evaluatePreContractMath({
      contractOfferPrice: 61_750,
      buyerMedian: 45_000, // top-buyer = Buyer_Median signal
      estRehab: 20_000, // typical Memphis 38109 distress range
      wholesaleFee: 5_000,
      cmaValidatedAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.status).toBe("block");
    expect(r.investorMao).toBe(25_000); // 45K − 20K
    expect(r.yourMao).toBe(20_000); // 25K − 5K
    expect(r.mao.status).toBe("block");
    expect(r.mao.reason).toContain("does not pass");
    expect(r.message).toContain("BLOCKED");
  });

  it("blocks even at zero rehab and the new $5K fee — Your_MAO=$40K, contract $61,750 > $40K", () => {
    // Sanity check: even if rehab were $0 and the fee is the new $5K
    // default, Investor_MAO=$45K, Your_MAO=$40K. Contract $61,750 still
    // exceeds Your_MAO → BLOCK.
    const r = evaluatePreContractMath({
      contractOfferPrice: 61_750,
      buyerMedian: 45_000,
      estRehab: 0,
      wholesaleFee: 5_000,
      cmaValidatedAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.status).toBe("block");
    expect(r.investorMao).toBe(45_000);
    expect(r.yourMao).toBe(40_000);
  });
});

describe("INV-023 anchor: 1219 E Highland Blvd 78210 → Investor_MAO ≈ $90K, Your_MAO=$85K at $5K fee", () => {
  it("produces Investor_MAO=$90,000 / Your_MAO=$85,000 on the canonical $120K Buyer_Median + $30K rehab inputs", () => {
    // Canonical from prior session work (Phase 4C.1 K.3 fixture):
    //   $165K ARV + $1400/mo rent → landlord $135K beats flipper $90K.
    // For the flipper track the Buyer_Median ≈ $120K (sold-comp median),
    // Est_Rehab ≈ $30K. Wholesale_Fee = $5K (Spine rec937cFJthvCZzBM).
    //   Investor_MAO = 120K − 30K = $90K
    //   Your_MAO    = 90K − 5K   = $85K
    const r = evaluatePreContractMath({
      contractOfferPrice: 70_000,
      buyerMedian: 120_000,
      estRehab: 30_000,
      wholesaleFee: 5_000,
      cmaValidatedAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.investorMao).toBe(90_000);
    expect(r.yourMao).toBe(85_000);
    expect(r.status).toBe("pass");
  });

  it("still produces Investor_MAO=$90K / Your_MAO=$85K even when contract is missing (math is independent of contract)", () => {
    const r = evaluatePreContractMath({
      contractOfferPrice: null,
      buyerMedian: 120_000,
      estRehab: 30_000,
      // No explicit wholesaleFee → uses DEFAULT ($5K) — exercises the constant.
      cmaValidatedAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
      now: NOW,
    });
    expect(r.investorMao).toBe(90_000);
    expect(r.yourMao).toBe(85_000);
    expect(r.status).toBe("hold"); // contract missing → hold, but math is right
  });
});
