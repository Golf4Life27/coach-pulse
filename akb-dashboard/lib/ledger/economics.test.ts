// Phase 15 / Q.4 — Ledger economics tests.

import { describe, it, expect } from "vitest";
import {
  computeDealPnL,
  computeRetirementProgress,
  readEconomicsConfig,
  rollupRevenue,
  type EconomicsConfig,
} from "./economics";
import type { Deal } from "@/lib/types";

function mkDeal(over: Partial<Deal> = {}): Deal {
  return {
    id: "recX",
    propertyAddress: "test",
    city: "SA",
    state: "TX",
    contractPrice: 100_000,
    offerPrice: 95_000,
    assignmentFee: 15_000,
    estimatedRepairs: null,
    arv: null,
    status: "Active",
    closingStatus: "Closed",
    dispoReady: false,
    propertyImageUrl: null,
    beds: null,
    baths: null,
    sqft: null,
    buyerBlastStatus: null,
    actionCardState: null,
    actionHoldUntil: null,
    ...over,
  };
}

const DEFAULT_CONFIG: EconomicsConfig = {
  operator_take_pct: 0.30,
  truck_fund_pct: 0.10,
  annual_retirement_target_usd: 120_000,
};

describe("readEconomicsConfig", () => {
  it("defaults to 30% take / 10% truck-fund when env unset", () => {
    expect(readEconomicsConfig({})).toEqual({
      operator_take_pct: 0.30,
      truck_fund_pct: 0.10,
      annual_retirement_target_usd: null,
    });
  });

  it("respects env overrides", () => {
    expect(
      readEconomicsConfig({
        LEDGER_OPERATOR_TAKE_PCT: "0.5",
        LEDGER_TRUCK_FUND_PCT: "0.2",
        LEDGER_ANNUAL_RETIREMENT_TARGET_USD: "250000",
      }),
    ).toEqual({
      operator_take_pct: 0.5,
      truck_fund_pct: 0.2,
      annual_retirement_target_usd: 250_000,
    });
  });

  it("ignores invalid percentages (>1 or ≤0)", () => {
    expect(readEconomicsConfig({ LEDGER_OPERATOR_TAKE_PCT: "1.5" }).operator_take_pct).toBe(0.30);
    expect(readEconomicsConfig({ LEDGER_OPERATOR_TAKE_PCT: "-0.1" }).operator_take_pct).toBe(0.30);
  });
});

describe("computeDealPnL", () => {
  it("closed deal with assignment fee → full P&L", () => {
    const r = computeDealPnL(mkDeal({ assignmentFee: 15_000 }), DEFAULT_CONFIG);
    expect(r.is_closed).toBe(true);
    expect(r.assignment_fee).toBe(15_000);
    expect(r.operator_take).toBe(4_500); // 30% of 15K
    expect(r.truck_fund_contribution).toBe(450); // 10% of 4.5K
    expect(r.net_to_operator).toBe(4_050); // 4500 - 450
  });

  it("non-closed deal → null financials, is_closed false", () => {
    const r = computeDealPnL(
      mkDeal({ closingStatus: "Negotiating", assignmentFee: 15_000 }),
      DEFAULT_CONFIG,
    );
    expect(r.is_closed).toBe(false);
    expect(r.operator_take).toBeNull();
    expect(r.truck_fund_contribution).toBeNull();
  });

  it("null assignmentFee → null financials even if closed", () => {
    const r = computeDealPnL(
      mkDeal({ closingStatus: "Closed", assignmentFee: null }),
      DEFAULT_CONFIG,
    );
    expect(r.operator_take).toBeNull();
  });

  it("recognizes alternate closing-status labels", () => {
    expect(computeDealPnL(mkDeal({ closingStatus: "Funded" }), DEFAULT_CONFIG).is_closed).toBe(true);
    expect(computeDealPnL(mkDeal({ closingStatus: "Wire received" }), DEFAULT_CONFIG).is_closed).toBe(true);
    expect(computeDealPnL(mkDeal({ closingStatus: "Won" }), DEFAULT_CONFIG).is_closed).toBe(true);
  });
});

describe("rollupRevenue", () => {
  it("aggregates closed deals correctly + ignores non-closed", () => {
    const rollup = rollupRevenue(
      [
        mkDeal({ id: "a", assignmentFee: 10_000, closingStatus: "Closed" }),
        mkDeal({ id: "b", assignmentFee: 20_000, closingStatus: "Funded" }),
        mkDeal({ id: "c", assignmentFee: 30_000, closingStatus: "Negotiating" }), // excluded
      ],
      DEFAULT_CONFIG,
    );
    expect(rollup.closed_count).toBe(2);
    expect(rollup.gross_assignment_fees).toBe(30_000);
    expect(rollup.total_operator_take).toBe(9_000); // 30% of 30K
    expect(rollup.total_truck_fund).toBe(900); // 10% of 9K
    expect(rollup.total_net_to_operator).toBe(8_100);
    expect(rollup.per_deal).toHaveLength(3);
  });

  it("empty deals → zero rollup", () => {
    const rollup = rollupRevenue([], DEFAULT_CONFIG);
    expect(rollup.closed_count).toBe(0);
    expect(rollup.gross_assignment_fees).toBe(0);
    expect(rollup.per_deal).toEqual([]);
  });
});

describe("computeRetirementProgress", () => {
  // Anchor: 2026-07-01 = ~6 months elapsed in calendar year.
  const NOW = new Date("2026-07-01T00:00:00Z");

  it("computes YTD take + progress against target", () => {
    const result = computeRetirementProgress(
      [
        mkDeal({ id: "a", assignmentFee: 20_000, closingStatus: "Closed" }),
        mkDeal({ id: "b", assignmentFee: 40_000, closingStatus: "Funded" }),
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(result.ytd_operator_take).toBe(18_000); // 30% of 60K
    expect(result.target_usd).toBe(120_000);
    expect(result.progress_pct).toBeCloseTo(0.15, 2);
    expect(result.months_elapsed).toBeCloseTo(6, 0);
    // 18K/6mo × 12 ≈ 36K — exact value depends on actual day count
    // (30.44 days/month vs 30 days). Tolerance ±5%.
    expect(result.projected_year_end_usd).toBeGreaterThan(35_000);
    expect(result.projected_year_end_usd).toBeLessThan(37_000);
    expect(result.pace_pct).toBeCloseTo(0.3, 1);
  });

  it("returns null progress when target unset", () => {
    const result = computeRetirementProgress(
      [mkDeal({ closingStatus: "Closed", assignmentFee: 50_000 })],
      { ...DEFAULT_CONFIG, annual_retirement_target_usd: null },
      NOW,
    );
    expect(result.progress_pct).toBeNull();
    expect(result.pace_pct).toBeNull();
  });

  it("handles zero closed deals (early in year, no revenue)", () => {
    const result = computeRetirementProgress([], DEFAULT_CONFIG, NOW);
    expect(result.ytd_operator_take).toBe(0);
    expect(result.progress_pct).toBe(0);
    expect(result.projected_year_end_usd).toBe(0);
  });
});
