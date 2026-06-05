// Market cap-rate sourcing — Track 2 (2026-06-05).
// @agent: appraiser
//
// The landlord lane (lib/landlord-lane.ts) needs a cap rate. The brief
// is strict: "cap rate must be SOURCED from real market data (RentCast
// market stats or a cited market report) — do NOT hardcode a guessed
// rate ... Return the sourced cap rate(s) per-market to Maverick for
// source-confirmation before it drives any live offer. No fabricated
// defaults — missing input = HOLD."
//
// This module DERIVES an implied market cap rate from RentCast's
// /v1/markets endpoint (zip-level median sale price + median long-term
// rent), with every assumption made explicit and a provenance string
// attached so Maverick/operator can confirm before live use. It NEVER
// returns a hardcoded fallback — if RentCast has no usable market data
// for the zip, it returns capRate:null (→ landlord lane HOLDs).
//
// ── Derivation ───────────────────────────────────────────────────────
//   gross_yield      = (median_rent × 12) / median_sale_price
//   implied_cap_rate = gross_yield × (1 − market_opex_ratio)
//
// market_opex_ratio is the single modeling assumption. It is surfaced in
// the result (assumptions.marketOpexRatio + provenance) for confirmation
// — this module does not silently bake a number into the cap; the caller
// passes it in explicitly. The derived cap is therefore fully traceable:
// RentCast medians (sourced) × a stated opex assumption (confirmable).
//
// The HTTP layer is injectable for tests; the pure derivation
// (deriveImpliedCapRate) is separately unit-tested.

const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
const BASE = "https://api.rentcast.io/v1";

export interface MarketCapRateResult {
  zip: string;
  /** Implied market cap rate as a fraction (e.g. 0.072), or null when it
   *  can't be sourced. null → caller HOLDs (no fabricated default). */
  capRate: number | null;
  grossYield: number | null;
  medianSalePrice: number | null;
  medianRent: number | null;
  /** Modeling assumption(s) used in the derivation — surfaced for
   *  Maverick source-confirmation. */
  assumptions: { marketOpexRatio: number };
  /** Human-readable provenance: exactly how this cap was derived. */
  provenance: string;
  source: "rentcast_markets_derived" | null;
  /** RentCast /markets HTTP status (diagnostic). */
  httpStatus: number | null;
  error: string | null;
}

/** Pure: derive an implied cap rate from market medians + an explicit
 *  opex assumption. Returns null when medians are missing/non-positive. */
export function deriveImpliedCapRate(input: {
  medianSalePrice: number | null | undefined;
  medianRent: number | null | undefined;
  marketOpexRatio: number;
}): { capRate: number | null; grossYield: number | null } {
  const { medianSalePrice, medianRent, marketOpexRatio } = input;
  if (
    typeof medianSalePrice !== "number" || !Number.isFinite(medianSalePrice) || medianSalePrice <= 0 ||
    typeof medianRent !== "number" || !Number.isFinite(medianRent) || medianRent <= 0 ||
    typeof marketOpexRatio !== "number" || !Number.isFinite(marketOpexRatio) || marketOpexRatio < 0 || marketOpexRatio >= 1
  ) {
    return { capRate: null, grossYield: null };
  }
  const grossYield = (medianRent * 12) / medianSalePrice;
  const capRate = grossYield * (1 - marketOpexRatio);
  return {
    grossYield: Math.round(grossYield * 10000) / 10000,
    capRate: Math.round(capRate * 10000) / 10000,
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
    capRate: null,
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

  const { capRate, grossYield } = deriveImpliedCapRate({ medianSalePrice, medianRent, marketOpexRatio });
  if (capRate == null) {
    return { ...base, error: "cap-rate derivation failed (non-positive medians or invalid opex ratio)" };
  }

  return {
    ...base,
    capRate,
    grossYield,
    source: "rentcast_markets_derived",
    provenance:
      `RentCast /markets zip ${zip}: median sale $${medianSalePrice.toLocaleString()}, ` +
      `median rent $${medianRent.toLocaleString()}/mo → gross yield ${(grossYield! * 100).toFixed(2)}% ` +
      `× (1 − opex ${(marketOpexRatio * 100).toFixed(0)}%) = implied cap ${(capRate * 100).toFixed(2)}%. ` +
      `CONFIRM the opex assumption + cap before driving any live offer.`,
  };
}
