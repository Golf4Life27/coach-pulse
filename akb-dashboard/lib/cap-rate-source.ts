// Market-implied cap — FLOOR SANITY-CHECK ONLY (Track 2; corrected
// 2026-06-05 per operator).
// @agent: appraiser
//
// ⚠️ DO NOT use the value from this module as the OPERATIVE cap in MAO
// math. It is the MARKET-IMPLIED cap, derived from RentCast /v1/markets
// median SALE price ÷ rent. Two reasons that's wrong for offer math:
//   1. Median-sale = RETAIL value, not the investor acquisition ceiling.
//      Using it overstates MAO ~30-50% and re-creates the 23 Fields
//      over-offer failure.
//   2. In non-disclosure TX, RentCast median-sale is AVM-DERIVED, so
//      feeding it into offer math pulls an AVM into pricing — a hard
//      violation of the V2.1 floor principle (no AVM in offers).
//
// The OPERATIVE cap MUST be a SOURCED, conservatively-high
// investor-required cap (real investor underwriting / market data),
// supplied + confirmed by the operator/Maverick — see
// lib/investor-cap.ts. This module's output may be surfaced ONLY as a
// floor sanity-check ("the investor-required cap should be ≥ the
// market-implied cap"), never as the operative input.
//
// ── Derivation (retail, AVM-contaminated — floor only) ───────────────
//   gross_yield        = (median_rent × 12) / median_sale_price
//   market_implied_cap = gross_yield × (1 − market_opex_ratio)
//
// The HTTP layer is injectable for tests; the pure derivation
// (deriveImpliedCapRate) is separately unit-tested.

const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
const BASE = "https://api.rentcast.io/v1";

export interface MarketCapRateResult {
  zip: string;
  /** MARKET-IMPLIED cap (RETAIL, AVM-contaminated). FLOOR SANITY-CHECK
   *  ONLY — never the operative cap in MAO math. null when unsourced. */
  marketImpliedCap: number | null;
  /** Hard flag so callers can't accidentally treat this as operative. */
  operative: false;
  grossYield: number | null;
  medianSalePrice: number | null;
  medianRent: number | null;
  assumptions: { marketOpexRatio: number };
  provenance: string;
  source: "rentcast_markets_derived" | null;
  httpStatus: number | null;
  error: string | null;
}

/** Pure: derive an implied cap rate from market medians + an explicit
 *  opex assumption. Returns null when medians are missing/non-positive. */
export function deriveImpliedCapRate(input: {
  medianSalePrice: number | null | undefined;
  medianRent: number | null | undefined;
  marketOpexRatio: number;
}): { marketImpliedCap: number | null; grossYield: number | null } {
  const { medianSalePrice, medianRent, marketOpexRatio } = input;
  if (
    typeof medianSalePrice !== "number" || !Number.isFinite(medianSalePrice) || medianSalePrice <= 0 ||
    typeof medianRent !== "number" || !Number.isFinite(medianRent) || medianRent <= 0 ||
    typeof marketOpexRatio !== "number" || !Number.isFinite(marketOpexRatio) || marketOpexRatio < 0 || marketOpexRatio >= 1
  ) {
    return { marketImpliedCap: null, grossYield: null };
  }
  const grossYield = (medianRent * 12) / medianSalePrice;
  const capRate = grossYield * (1 - marketOpexRatio);
  return {
    grossYield: Math.round(grossYield * 10000) / 10000,
    marketImpliedCap: Math.round(capRate * 10000) / 10000,
  };
}

/** Pure: pull median sale price + median long-term rent from a RentCast
 *  /markets payload. RentCast returns saleData / rentalData blocks with
 *  averagePrice / medianPrice and averageRent / medianRent. */
export function extractMarketMedians(body: Record<string, unknown> | null | undefined): {
  medianSalePrice: number | null;
  medianRent: number | null;
} {
  if (!body || typeof body !== "object") return { medianSalePrice: null, medianRent: null };
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  const sale = (body.saleData ?? {}) as Record<string, unknown>;
  const rental = (body.rentalData ?? {}) as Record<string, unknown>;
  return {
    medianSalePrice: num(sale.medianPrice) ?? num(sale.averagePrice),
    medianRent: num(rental.medianRent) ?? num(rental.averageRent),
  };
}

export interface CapRateSourceDeps {
  fetchMarkets?: (zip: string) => Promise<{ status: number; body: Record<string, unknown> | null }>;
}

async function defaultFetchMarkets(zip: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${BASE}/markets?zipCode=${encodeURIComponent(zip)}&dataType=All`, {
    headers: { "X-Api-Key": RENTCAST_API_KEY ?? "" },
    cache: "no-store",
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * Source an implied market cap rate for a zip from RentCast /markets.
 * Never throws; on any failure returns capRate:null with the reason so
 * the caller HOLDs rather than guessing.
 *
 * @param marketOpexRatio explicit, confirmable opex assumption (fraction
 *        of gross rent). Required — no default here.
 */
export async function sourceMarketCapRate(
  zip: string,
  marketOpexRatio: number,
  deps: CapRateSourceDeps = {},
): Promise<MarketCapRateResult> {
  const base: MarketCapRateResult = {
    zip,
    marketImpliedCap: null,
    operative: false,
    grossYield: null,
    medianSalePrice: null,
    medianRent: null,
    assumptions: { marketOpexRatio },
    provenance: "",
    source: null,
    httpStatus: null,
    error: null,
  };
  if (!RENTCAST_API_KEY && !deps.fetchMarkets) {
    return { ...base, error: "RENTCAST_API_KEY not set" };
  }
  if (!/^\d{5}$/.test(zip)) {
    return { ...base, error: `invalid zip "${zip}"` };
  }

  const fetcher = deps.fetchMarkets ?? defaultFetchMarkets;
  let resp: { status: number; body: Record<string, unknown> | null };
  try {
    resp = await fetcher(zip);
  } catch (err) {
    return { ...base, error: String(err).slice(0, 200) };
  }
  base.httpStatus = resp.status;
  if (resp.status < 200 || resp.status >= 300) {
    return { ...base, error: `RentCast /markets HTTP ${resp.status}` };
  }

  const { medianSalePrice, medianRent } = extractMarketMedians(resp.body);
  base.medianSalePrice = medianSalePrice;
  base.medianRent = medianRent;
  if (medianSalePrice == null || medianRent == null) {
    return { ...base, error: "RentCast /markets returned no usable median sale price / rent for this zip" };
  }

  const { marketImpliedCap: capRate, grossYield } = deriveImpliedCapRate({ medianSalePrice, medianRent, marketOpexRatio });
  if (capRate == null) {
    return { ...base, error: "cap-rate derivation failed (non-positive medians or invalid opex ratio)" };
  }

  return {
    ...base,
    marketImpliedCap: capRate,
    grossYield,
    source: "rentcast_markets_derived",
    provenance:
      `FLOOR ONLY (NOT operative): RentCast /markets zip ${zip} median sale $${medianSalePrice.toLocaleString()} ` +
      `(AVM-derived in non-disclosure TX), median rent $${medianRent.toLocaleString()}/mo → gross yield ` +
      `${(grossYield! * 100).toFixed(2)}% × (1 − opex ${(marketOpexRatio * 100).toFixed(0)}%) = market-implied ` +
      `cap ${(capRate * 100).toFixed(2)}%. This is RETAIL — use only to sanity-check that the SOURCED ` +
      `investor-required cap is ≥ this. Never feed it into offer math.`,
  };
}
