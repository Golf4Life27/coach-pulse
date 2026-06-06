// Market-agnostic deal-math engine.
// @agent: orchestrator
//
// ONE FORMULA, ONE CODE PATH, EVERY MARKET. The deal's market is resolved
// from the listing; its buyer params (ARV%Max, Max_Rehab, Max_Price,
// criteria) are read from the config-row registry. No per-market
// branches anywhere downstream.
//
//   MAO = ARV × market.ARV%Max − rehab − fee
//
// A deal PASSES only when all four gates clear:
//   spread_ok   : MAO − list_price ≥ 0  (or contract_price when set)
//   rehab_ok    : rehab ≤ market.Max_Rehab
//   price_ok    : list_price ≤ market.Max_Price  (skip when Max_Price null)
//   criteria_ok : beds, baths, year_built, sqft, property_type all fit
//
// HOLD on any missing input (ARV, rehab, list price, params). Never
// compute on an input we can't trust. Same posture as cap/tax gates.
//
// Pure. No I/O. Tested in lib/markets/deal-math.test.ts.

import type { Market } from "./registry";
import { getWholesaleFeeDefault, isMarketLive } from "./registry";

export interface DealMathInput {
  /** Subject ARV — MUST come from a verified retail-sold-comp source
   *  (e.g. ATTOM /salescomparables in a disclosure state). NEVER AVM. */
  arv: number | null | undefined;
  rehab: number | null | undefined;
  /** Current list price or contract price (whichever drives the gate). */
  listPrice: number | null | undefined;
  contractPrice?: number | null | undefined;
  /** Buy-box criteria inputs from the listing. */
  beds?: number | null | undefined;
  baths?: number | null | undefined;
  yearBuilt?: number | null | undefined;
  sqft?: number | null | undefined;
  propertyType?: string | null | undefined;
  /** Optional fee override; defaults to registry wholesale_fee_default. */
  wholesaleFee?: number;
}

export type DealStatus = "pass" | "hold" | "block";

export interface GateResult {
  ok: boolean;
  reason: string;
}

export interface DealMathResult {
  status: DealStatus;
  /** market-agnostic MAO = ARV × ARV%Max − rehab − fee, rounded.
   *  null on HOLD (missing inputs or market not live). */
  mao: number | null;
  /** The price we're evaluating against (contract > list). */
  pricingFloor: number | null;
  /** spread = MAO − pricingFloor. Negative = uneconomic. null on HOLD. */
  spread: number | null;
  gates: {
    market_live: GateResult;
    spread: GateResult;
    rehab: GateResult;
    price: GateResult;
    criteria: GateResult;
  };
  /** Echo of the inputs the engine actually used (provenance / audit). */
  used: {
    arv: number | null;
    rehab: number | null;
    fee: number;
    arv_pct_max: number | null;
    max_rehab: number | null;
    max_price: number | null;
    pricing_basis: "contract_price" | "list_price" | "none";
  };
  /** Human-readable summary. */
  reason: string;
}

function holdResult(market: Market | null, reason: string, fee: number, used: Partial<DealMathResult["used"]> = {}): DealMathResult {
  return {
    status: "hold",
    mao: null,
    pricingFloor: null,
    spread: null,
    gates: {
      market_live: { ok: market != null, reason: market ? "market matched" : "no market" },
      spread: { ok: false, reason: "not evaluated" },
      rehab: { ok: false, reason: "not evaluated" },
      price: { ok: false, reason: "not evaluated" },
      criteria: { ok: false, reason: "not evaluated" },
    },
    used: {
      arv: null,
      rehab: null,
      fee,
      arv_pct_max: market?.buyer_params?.arv_pct_max ?? null,
      max_rehab: market?.buyer_params?.max_rehab_usd ?? null,
      max_price: market?.buyer_params?.max_price_usd ?? null,
      pricing_basis: "none",
      ...used,
    },
    reason,
  };
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Pure: does the listing fit the market's buy-box criteria? Each criterion
 *  is OPTIONAL — null in the registry means "no constraint". A null on the
 *  LISTING side for a constrained criterion is a HOLD (insufficient info),
 *  surfaced via ok:false reason — caller decides whether to HOLD or block. */
export function evaluateCriteria(
  input: DealMathInput,
  market: Market,
): GateResult {
  const c = market.buyer_params?.criteria;
  if (!c) return { ok: true, reason: "no criteria gates configured" };
  const fails: string[] = [];

  const checkMin = (label: string, val: unknown, min: number | null) => {
    if (min == null) return;
    const v = num(val);
    if (v == null) { fails.push(`${label}=null (criterion requires ≥${min})`); return; }
    if (v < min) fails.push(`${label}=${v} < ${min}`);
  };
  const checkMax = (label: string, val: unknown, max: number | null) => {
    if (max == null) return;
    const v = num(val);
    if (v == null) { fails.push(`${label}=null (criterion requires ≤${max})`); return; }
    if (v > max) fails.push(`${label}=${v} > ${max}`);
  };

  checkMin("beds", input.beds, c.beds_min);
  checkMin("baths", input.baths, c.baths_min);
  checkMin("year_built", input.yearBuilt, c.year_built_min);
  checkMin("sqft", input.sqft, c.sqft_min);
  checkMax("sqft", input.sqft, c.sqft_max);

  if (c.property_types_allowed && c.property_types_allowed.length > 0) {
    const t = (input.propertyType ?? "").toLowerCase();
    if (!t) fails.push("property_type=null");
    else if (!c.property_types_allowed.some((p) => t.includes(p.toLowerCase()))) {
      fails.push(`property_type="${t}" not in allowed ${JSON.stringify(c.property_types_allowed)}`);
    }
  }

  return fails.length === 0
    ? { ok: true, reason: "criteria pass" }
    : { ok: false, reason: `criteria fail: ${fails.join("; ")}` };
}

/** Pure: market-agnostic deal evaluation. The deal-math engine. */
export function evaluateDeal(input: DealMathInput, market: Market | null): DealMathResult {
  const fee = num(input.wholesaleFee) ?? getWholesaleFeeDefault();

  const live = isMarketLive(market);
  if (!live.live || !market || !market.buyer_params) {
    return holdResult(market, `market not live: ${live.reasons.join("; ")}`, fee);
  }

  const arv = num(input.arv);
  const rehab = num(input.rehab);
  const list = num(input.listPrice);
  const contract = num(input.contractPrice);
  const arvPct = market.buyer_params.arv_pct_max;
  const maxRehab = market.buyer_params.max_rehab_usd;
  const maxPrice = market.buyer_params.max_price_usd;

  // HOLD on missing inputs — never compute on guesses.
  const missing: string[] = [];
  if (arv == null || arv <= 0) missing.push("arv");
  if (rehab == null || rehab < 0) missing.push("rehab");
  if (list == null && contract == null) missing.push("list_price_or_contract_price");
  if (missing.length > 0) {
    return holdResult(market, `HOLD — missing input(s): ${missing.join(", ")}`, fee, {
      arv,
      rehab,
      arv_pct_max: arvPct,
      max_rehab: maxRehab,
      max_price: maxPrice,
      pricing_basis: contract != null ? "contract_price" : (list != null ? "list_price" : "none"),
    });
  }

  // Single-formula MAO. arv/rehab are non-null by the guard above.
  const mao = Math.round((arv as number) * arvPct - (rehab as number) - fee);

  // Pricing basis: contract > list. The spread gate evaluates against
  // whichever is set (deal can be contracted at a number that differs
  // from list — the contract IS the deal price at that point).
  const pricingFloor = contract ?? (list as number);
  const pricingBasis: "contract_price" | "list_price" = contract != null ? "contract_price" : "list_price";
  const spread = mao - pricingFloor;

  const spreadOk = spread >= 0;
  const rehabOk = (rehab as number) <= maxRehab;
  const priceOk = maxPrice == null ? true : pricingFloor <= maxPrice;
  const criteriaRes = evaluateCriteria(input, market);

  // Status: pass when every gate clears; block when math is decisive
  // against the deal (spread<0, rehab>max, price>max — these are hard
  // failures, not missing data); hold when criteria HOLDs on null inputs.
  let status: DealStatus;
  if (spreadOk && rehabOk && priceOk && criteriaRes.ok) status = "pass";
  else if (!spreadOk || !rehabOk || !priceOk || (!criteriaRes.ok && !criteriaRes.reason.includes("=null"))) status = "block";
  else status = "hold";

  return {
    status,
    mao,
    pricingFloor,
    spread,
    gates: {
      market_live: { ok: true, reason: "market live" },
      spread: { ok: spreadOk, reason: `spread $${spread.toLocaleString()} ${spreadOk ? "≥" : "<"} 0` },
      rehab: { ok: rehabOk, reason: `rehab $${(rehab as number).toLocaleString()} ${rehabOk ? "≤" : ">"} max $${maxRehab.toLocaleString()}` },
      price: { ok: priceOk, reason: maxPrice == null ? "no max_price set" : `price $${pricingFloor.toLocaleString()} ${priceOk ? "≤" : ">"} max $${maxPrice.toLocaleString()}` },
      criteria: criteriaRes,
    },
    used: {
      arv,
      rehab,
      fee,
      arv_pct_max: arvPct,
      max_rehab: maxRehab,
      max_price: maxPrice,
      pricing_basis: pricingBasis,
    },
    reason: status === "pass"
      ? `PASS — MAO $${mao.toLocaleString()} ≥ ${pricingBasis} $${pricingFloor.toLocaleString()} (spread $${spread.toLocaleString()})`
      : status === "block"
      ? `BLOCK — ${[!spreadOk && "negative spread", !rehabOk && "rehab over max", !priceOk && "price over max", !criteriaRes.ok && criteriaRes.reason].filter(Boolean).join("; ")}`
      : `HOLD — ${criteriaRes.reason}`,
  };
}
