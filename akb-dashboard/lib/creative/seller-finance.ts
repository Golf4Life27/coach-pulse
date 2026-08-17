// Seller-finance (creative lane) offer pricer — pure. @agent: appraiser
//
// THE LANE (operator green-light 2026-08-17, spine recNb0eYjIyeyCnPW; spec
// captured from BBC Deal Checker v2, spine rec4zsAGJKEm9HJNC; first live
// case 3470 Hadley Ave, spine reclGWrXeJIy0u7ER): records the CASH lane
// correctly refuses — cash_no_pencil (value known, cash can't work) and
// infeasible_ask (ask structurally unreachable at any defensible cash
// number) — get a TERMS offer instead: the seller receives (near) their
// price, the concession is TIME. Price is deliberately ask-anchored in
// this lane; the payment is anchored to RENT, and a VALUE CAP keeps the
// price honest. This inverts the cash doctrine ON PURPOSE and must never
// leak into the cash opener path (lib/per-market-pricer et al. unchanged).
//
// THE SHAPE (BBC worked example, 3470 Hadley: ask $95,000, rent $905/mo →
// full price, $8k down, $350/mo principal-only, 0% interest, no balloon;
// wholesale fee comes out of the BUYER'S ENTRY, not a cash spread):
//   price   = min(ask, ARV × value_cap)          — never above value
//   payment = rent-carried: what's left after operating overhead and the
//             buyer's cashflow floor, with an anchor margin
//   down    = seller's day-one cash, clamped so total entry (down + fee +
//             closing) stays inside the buyer's entry ceiling
//   term    = principal / payment, principal-only; > TERM_MAX ⇒ HOLD
//             (a balloon is a negotiation structure, not an auto-send)
//
// DOCTRINE CARRIED OVER FROM THE CASH LANE (INVARIANTS §1/§2 spirit):
// every guard HOLDs rather than guessing — no rent estimate ⇒ HOLD, no
// trusted ARV basis ⇒ HOLD, thin rent ⇒ HOLD. Each hold names its OWNER
// (machine-fixable vs operator) so the hold pile stays an instrument, and
// after the needs_seed/size_extrapolation mislabel lessons every owner
// label states the ACTUAL remedy.
//
// Pure. No I/O. All thresholds env-tunable via readSellerFinanceConfig.

export interface SellerFinanceConfig {
  /** Share of rent consumed by taxes/insurance/maintenance/vacancy. */
  overheadPct: number;
  /** Buyer's minimum monthly cashflow after payment + overhead. */
  cashflowFloorUsd: number;
  /** Payments quoted in multiples of this. */
  paymentRoundUsd: number;
  /** Anchor margin: quote below the buyer's absolute max payment. */
  paymentAnchor: number;
  /** Seller's day-one cash target as a share of price. */
  downPct: number;
  /** Floor on the down payment (agent commission + seller dignity). */
  downMinUsd: number;
  /** Closing-cost estimate as a share of price. */
  closingPct: number;
  /** Ceiling on (down + fee + closing) / price — the buyer's entry. */
  entryPctMax: number;
  /** Buyer cash-on-cash floor: (cashflow × 12) / entry. */
  cocMin: number;
  /** Principal-only term ceiling in months; beyond ⇒ needs a balloon ⇒ HOLD. */
  termMaxMonths: number;
  /** Price cap as a multiple of the trusted ARV basis. */
  valueCap: number;
  /** Prices/downs rounded to this. */
  priceRoundUsd: number;
  /** Default wholesale fee when the record carries none. */
  wholesaleFeeDefaultUsd: number;
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** Env-tunable config (SF_* vars), BBC-calibrated defaults. */
export function readSellerFinanceConfig(env: Record<string, string | undefined> = process.env): SellerFinanceConfig {
  return {
    overheadPct: num(env.SF_OVERHEAD_PCT, 0.40),
    cashflowFloorUsd: num(env.SF_CASHFLOW_FLOOR_USD, 150),
    paymentRoundUsd: num(env.SF_PAYMENT_ROUND_USD, 25),
    paymentAnchor: num(env.SF_PAYMENT_ANCHOR, 0.9),
    downPct: num(env.SF_DOWN_PCT, 0.10),
    downMinUsd: num(env.SF_DOWN_MIN_USD, 2000),
    closingPct: num(env.SF_CLOSING_PCT, 0.0125),
    entryPctMax: num(env.SF_ENTRY_PCT_MAX, 0.25),
    cocMin: num(env.SF_COC_MIN, 0.12),
    termMaxMonths: num(env.SF_TERM_MAX_MONTHS, 360),
    valueCap: num(env.SF_VALUE_CAP, 1.0),
    priceRoundUsd: num(env.SF_PRICE_ROUND_USD, 250),
    wholesaleFeeDefaultUsd: num(env.SF_WHOLESALE_FEE_USD, 5000),
  };
}

export type SellerFinanceHoldReason =
  | "no_list_price"       // owner: data — record is malformed
  | "no_rent_estimate"    // owner: auto_rent — the P2 rent leg backfills this, no human
  | "no_value_basis"      // owner: same as cash lane — no trusted ARV, never price blind
  | "rent_too_thin"       // owner: deal_shape — rent cannot carry any payment above the floor
  | "entry_too_heavy"     // owner: deal_shape — fee+closing alone break the buyer's entry ceiling
  | "needs_balloon"       // owner: operator — >30y principal-only; balloon is a negotiated structure
  | "buyer_return_thin";  // owner: deal_shape — cash-on-cash below floor; not dispo-able

export interface SellerFinanceOffer {
  verdict: "sendable_terms";
  /** Offered price — min(ask, ARV × valueCap), rounded. */
  price: number;
  /** True when the value cap pulled price below the ask. */
  priceCappedToValue: boolean;
  downPayment: number;
  monthlyPayment: number;
  termMonths: number;
  wholesaleFee: number;
  closingCosts: number;
  totalEntry: number;
  entryPct: number;
  buyerMonthlyCashflow: number;
  buyerCashOnCash: number;
  arvBasisUsed: number;
  derivation: string;
}

export interface SellerFinanceHold {
  verdict: "hold";
  reason: SellerFinanceHoldReason;
  /** True when a machine lane (rent backfill / comp evidence) can clear it. */
  automatable: boolean;
  detail: string;
}

export type SellerFinanceResult = SellerFinanceOffer | SellerFinanceHold;

export interface SellerFinanceInput {
  listPrice: number | null | undefined;
  /** RentCast AVM monthly rent (Listing.estimatedMonthlyRent). */
  monthlyRent: number | null | undefined;
  /** Trusted ARV per the cash lane's basis hierarchy (own_comps → seed → stored). */
  arvBasis: number | null | undefined;
  arvSource: "own_comps" | "seed_renovated" | "stored" | "none";
  wholesaleFee?: number | null;
}

const pos = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

const roundTo = (v: number, step: number): number => Math.round(v / step) * step;
const floorTo = (v: number, step: number): number => Math.floor(v / step) * step;

/** Pure: derive the seller-finance terms offer, or HOLD with a named owner. */
export function priceSellerFinance(
  input: SellerFinanceInput,
  cfg: SellerFinanceConfig = readSellerFinanceConfig(),
): SellerFinanceResult {
  if (!pos(input.listPrice)) {
    return { verdict: "hold", reason: "no_list_price", automatable: false, detail: "no positive list price on the record" };
  }
  if (!pos(input.monthlyRent)) {
    return {
      verdict: "hold", reason: "no_rent_estimate", automatable: true,
      detail: "no RentCast rent estimate — the appraiser rent leg backfills this; no human",
    };
  }
  if (input.arvSource === "none" || !pos(input.arvBasis)) {
    return {
      verdict: "hold", reason: "no_value_basis", automatable: true,
      detail: "no trusted ARV basis — a terms price is still a price; never offered blind (same rule as cash)",
    };
  }

  // ── Price: the ask, capped at value. The concession in this lane is time,
  // never paying above what the evidence supports.
  const valueCapUsd = roundTo(input.arvBasis * cfg.valueCap, cfg.priceRoundUsd);
  const price = Math.min(roundTo(input.listPrice, cfg.priceRoundUsd), valueCapUsd);
  const priceCappedToValue = price < roundTo(input.listPrice, cfg.priceRoundUsd);

  // ── Payment: what the rent can carry after overhead and the buyer's
  // cashflow floor, quoted with an anchor margin.
  const rentAfterOverhead = input.monthlyRent * (1 - cfg.overheadPct);
  const paymentMax = rentAfterOverhead - cfg.cashflowFloorUsd;
  const payment = floorTo(paymentMax * cfg.paymentAnchor, cfg.paymentRoundUsd);
  if (!(payment >= cfg.paymentRoundUsd * 2)) {
    return {
      verdict: "hold", reason: "rent_too_thin", automatable: false,
      detail: `rent $${input.monthlyRent}/mo cannot carry a payment above the buyer floor (max $${Math.max(0, Math.round(paymentMax))})`,
    };
  }

  // ── Entry: seller's day-one cash + our fee + closing, inside the buyer's
  // entry ceiling. Down flexes downward to fit; fee does not (the fee IS the
  // business model in this lane).
  const fee = pos(input.wholesaleFee) ? input.wholesaleFee : cfg.wholesaleFeeDefaultUsd;
  const closing = Math.round(price * cfg.closingPct);
  const downTarget = roundTo(price * cfg.downPct, cfg.priceRoundUsd);
  const downCeiling = floorTo(price * cfg.entryPctMax - fee - closing, cfg.priceRoundUsd);
  const down = Math.min(downTarget, downCeiling);
  if (down < cfg.downMinUsd) {
    return {
      verdict: "hold", reason: "entry_too_heavy", automatable: false,
      detail: `fee $${fee} + closing $${closing} leave no room for a real down payment inside the ${Math.round(cfg.entryPctMax * 100)}% entry ceiling at price $${price}`,
    };
  }
  const entry = down + fee + closing;
  const entryPct = entry / price;

  // ── Term: principal-only. Beyond the ceiling a balloon is required, and a
  // balloon is a negotiated structure — operator judgment, never auto-sent.
  const principal = price - down;
  const termMonths = Math.ceil(principal / payment);
  if (termMonths > cfg.termMaxMonths) {
    return {
      verdict: "hold", reason: "needs_balloon", automatable: false,
      detail: `principal $${principal} at $${payment}/mo runs ${termMonths} months (> ${cfg.termMaxMonths}); needs a balloon structure — operator call`,
    };
  }

  // ── Buyer return: the deal must be dispo-able or the offer is noise.
  const cashflow = Math.round(rentAfterOverhead - payment);
  const coc = (cashflow * 12) / entry;
  if (cashflow < cfg.cashflowFloorUsd || coc < cfg.cocMin) {
    return {
      verdict: "hold", reason: "buyer_return_thin", automatable: false,
      detail: `buyer cashflow $${cashflow}/mo, cash-on-cash ${(coc * 100).toFixed(1)}% — below floor; not dispo-able`,
    };
  }

  return {
    verdict: "sendable_terms",
    price,
    priceCappedToValue,
    downPayment: down,
    monthlyPayment: payment,
    termMonths,
    wholesaleFee: fee,
    closingCosts: closing,
    totalEntry: entry,
    entryPct,
    buyerMonthlyCashflow: cashflow,
    buyerCashOnCash: coc,
    arvBasisUsed: input.arvBasis,
    derivation:
      `price=min(ask,arv×${cfg.valueCap})=$${price}${priceCappedToValue ? " (value-capped)" : ""}; ` +
      `payment=floor25((rent $${input.monthlyRent}×${1 - cfg.overheadPct}−$${cfg.cashflowFloorUsd})×${cfg.paymentAnchor})=$${payment}/mo; ` +
      `down=$${down}+fee $${fee}+closing $${closing}=entry $${entry} (${(entryPct * 100).toFixed(1)}%); ` +
      `term=${termMonths}mo principal-only; buyer cashflow $${cashflow}/mo, CoC ${(coc * 100).toFixed(1)}%`,
  };
}
