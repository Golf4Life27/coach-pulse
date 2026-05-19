// Phase 15 / Q.4 — Ledger economics MVP.
//
// Pure helpers computing revenue, P&L, retirement progress, and
// truck-fund accumulation across the deal pipeline. Inputs are Deal
// records (lib/types.Deal) + simple env-driven config (annual
// retirement target). No I/O — the route layer calls these against
// fetched deals.
//
// Coverage:
//   15.1 — revenue per deal (DealPnL)
//   15.3 — truck fund (10% of 30% revenue per Alex's spec)
//   15.4 — wife retirement progress meter (annual income replacement)
//   15.5 — deal-by-deal P&L shape (consumed by future /ledger UI)
//
// 15.2 (per-agent LLM cost attribution) lives in cost-attribution.ts.

import type { Deal } from "@/lib/types";

/** Per-Alex defaults — truck-fund is 10% of the operator's standard
 *  30% revenue split. Operator can override via env. */
const DEFAULT_TRUCK_FUND_PCT = 0.10;
const DEFAULT_OPERATOR_TAKE_PCT = 0.30;

export function readEconomicsConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): EconomicsConfig {
  const parsePct = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
    return n;
  };
  const parseUsd = (v: string | undefined): number | null => {
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  };
  return {
    operator_take_pct: parsePct(env.LEDGER_OPERATOR_TAKE_PCT, DEFAULT_OPERATOR_TAKE_PCT),
    truck_fund_pct: parsePct(env.LEDGER_TRUCK_FUND_PCT, DEFAULT_TRUCK_FUND_PCT),
    annual_retirement_target_usd: parseUsd(env.LEDGER_ANNUAL_RETIREMENT_TARGET_USD),
  };
}

export interface EconomicsConfig {
  /** Operator's share of assignment fee (default 30% per Alex). */
  operator_take_pct: number;
  /** Truck-fund share of OPERATOR take (default 10% of 30% = 3% of gross). */
  truck_fund_pct: number;
  /** Annual income replacement target for the wife-retirement meter.
   *  Null when operator hasn't configured — meter renders "not set"
   *  until they fill it in. */
  annual_retirement_target_usd: number | null;
}

export interface DealPnL {
  deal_id: string;
  property_address: string;
  status: string | null;
  closing_status: string | null;
  /** Assignment fee = total revenue at close. */
  assignment_fee: number | null;
  /** Operator's share. */
  operator_take: number | null;
  /** Truck-fund accumulation from this deal. */
  truck_fund_contribution: number | null;
  /** Net to operator after truck-fund. */
  net_to_operator: number | null;
  /** Whether this deal is considered closed (revenue counted). */
  is_closed: boolean;
}

const CLOSED_STATUSES = new Set([
  "Closed",
  "Funded",
  "Wire received",
  "Won",
]);

/** Pure: project a single Deal record into a P&L row. */
export function computeDealPnL(deal: Deal, config: EconomicsConfig): DealPnL {
  const closing = deal.closingStatus ?? "";
  const isClosed = CLOSED_STATUSES.has(closing);
  const fee = deal.assignmentFee;
  if (fee == null || fee <= 0 || !isClosed) {
    return {
      deal_id: deal.id,
      property_address: deal.propertyAddress,
      status: deal.status,
      closing_status: deal.closingStatus,
      assignment_fee: fee,
      operator_take: null,
      truck_fund_contribution: null,
      net_to_operator: null,
      is_closed: isClosed,
    };
  }
  const operatorTake = Math.round(fee * config.operator_take_pct);
  const truckFund = Math.round(operatorTake * config.truck_fund_pct);
  return {
    deal_id: deal.id,
    property_address: deal.propertyAddress,
    status: deal.status,
    closing_status: deal.closingStatus,
    assignment_fee: fee,
    operator_take: operatorTake,
    truck_fund_contribution: truckFund,
    net_to_operator: operatorTake - truckFund,
    is_closed: true,
  };
}

export interface RevenueRollup {
  /** Closed-deal count contributing to revenue. */
  closed_count: number;
  /** Sum of assignment fees on closed deals (gross revenue). */
  gross_assignment_fees: number;
  /** Operator's total take (sum of per-deal operator_take). */
  total_operator_take: number;
  /** Cumulative truck-fund balance. */
  total_truck_fund: number;
  /** Net to operator after truck-fund. */
  total_net_to_operator: number;
  per_deal: DealPnL[];
}

/** Pure: aggregate P&L across deals. */
export function rollupRevenue(deals: Deal[], config: EconomicsConfig): RevenueRollup {
  const per_deal = deals.map((d) => computeDealPnL(d, config));
  const closed = per_deal.filter((p) => p.is_closed);
  const gross = closed.reduce((sum, p) => sum + (p.assignment_fee ?? 0), 0);
  const take = closed.reduce((sum, p) => sum + (p.operator_take ?? 0), 0);
  const truck = closed.reduce((sum, p) => sum + (p.truck_fund_contribution ?? 0), 0);
  const net = closed.reduce((sum, p) => sum + (p.net_to_operator ?? 0), 0);
  return {
    closed_count: closed.length,
    gross_assignment_fees: gross,
    total_operator_take: take,
    total_truck_fund: truck,
    total_net_to_operator: net,
    per_deal,
  };
}

export interface RetirementProgress {
  /** Annual income replacement target — null when operator hasn't
   *  set LEDGER_ANNUAL_RETIREMENT_TARGET_USD. */
  target_usd: number | null;
  /** Operator take year-to-date (deals closed in current calendar
   *  year). */
  ytd_operator_take: number;
  /** Progress as fraction of target [0,1]; null when target unset. */
  progress_pct: number | null;
  /** Months elapsed in year (decimal — partial month counted). */
  months_elapsed: number;
  /** Pace projection — at YTD rate, how much would operator hit by
   *  year-end? Null when months_elapsed is 0 (avoid div-by-zero
   *  on Jan 1). */
  projected_year_end_usd: number | null;
  /** Pace vs target [0,1+]; null when target unset OR pace null. */
  pace_pct: number | null;
}

/** Pure: compute YTD progress against the annual retirement target.
 *  `now` lets tests anchor to a specific date. Deal closures use the
 *  Listing's lastInbound/lastOutbound proxy — Deal type doesn't carry
 *  a close-date field; conservative: include all closed deals as
 *  YTD until close-date tracking lands (Phase 21 backlog). */
export function computeRetirementProgress(
  deals: Deal[],
  config: EconomicsConfig,
  now: Date = new Date(),
): RetirementProgress {
  const rollup = rollupRevenue(deals, config);
  const ytdTake = rollup.total_operator_take;
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const monthsElapsed = Math.max(
    0.01,
    (now.getTime() - yearStart.getTime()) / (30.44 * 86_400_000),
  );
  const projected =
    monthsElapsed > 0 ? Math.round((ytdTake / monthsElapsed) * 12) : null;
  return {
    target_usd: config.annual_retirement_target_usd,
    ytd_operator_take: ytdTake,
    progress_pct:
      config.annual_retirement_target_usd && config.annual_retirement_target_usd > 0
        ? Math.round((ytdTake / config.annual_retirement_target_usd) * 1000) / 1000
        : null,
    months_elapsed: Math.round(monthsElapsed * 100) / 100,
    projected_year_end_usd: projected,
    pace_pct:
      config.annual_retirement_target_usd &&
      config.annual_retirement_target_usd > 0 &&
      projected != null
        ? Math.round((projected / config.annual_retirement_target_usd) * 1000) / 1000
        : null,
  };
}
