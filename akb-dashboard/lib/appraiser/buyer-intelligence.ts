// Phase 4C.1 — Buyer Intelligence Dual-Track.
// @agent: appraiser
//
// Pure helpers for the standalone /api/agents/appraiser/
// buyer-intelligence/[recordId] endpoint. Computes BOTH:
//
//   FLIPPER TRACK — V2.1 floor math from mao-range.ts:
//     flipper_mao = MAX(arv_mid − rehab − wholesale_fee, 0)
//
//   LANDLORD TRACK — cap-rate × annual rent:
//     landlord_mao = MAX((monthly_rent × 12) / cap_rate − rehab − wholesale_fee, 0)
//
// The higher of the two = dominant_value, the real buyer-facing
// MAO ceiling. Single-track pricing leaves money on the table on
// landlord-friendly deals.
//
// **Coexists with `lib/pricing-math.ts`** (Pricing Agent's
// sophisticated dual-track w/ closing_costs + vacancy + opex +
// buyer_profit). This module mirrors the simpler V2.1-floor variant
// so the MAO range envelope (mao-range.ts) gets a dual-track-aware
// floor without pulling in the full Pricing Agent dependency surface.
//
// Per-market cap rates (env-overridable):
//   TX-Metro             8% (SA / Dallas / Houston)
//   TN-Distressed       10% (Memphis)
//   MI-Distressed        9% (Detroit)
//   Conservative-Default 9% (anywhere else)

import { marketTierForState, type MarketTier } from "./rehab-calibration";

const MARKET_CAP_RATE_DEFAULTS: Record<MarketTier, number> = {
  "TX-Metro": 0.08,
  "TN-Distressed": 0.10,
  "MI-Distressed": 0.09,
  "Conservative-Default": 0.09,
};

/** Read per-tier cap rates with env override. Pure given env.
 *  Invalid values (non-numeric, ≤0, ≥1) fall through to defaults. */
export function readMarketCapRates(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<MarketTier, number> {
  const parse = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
  };
  return {
    "TX-Metro": parse(env.BUYER_CAP_RATE_TX_METRO, MARKET_CAP_RATE_DEFAULTS["TX-Metro"]),
    "TN-Distressed": parse(env.BUYER_CAP_RATE_TN_DISTRESSED, MARKET_CAP_RATE_DEFAULTS["TN-Distressed"]),
    "MI-Distressed": parse(env.BUYER_CAP_RATE_MI_DISTRESSED, MARKET_CAP_RATE_DEFAULTS["MI-Distressed"]),
    "Conservative-Default": parse(env.BUYER_CAP_RATE_DEFAULT, MARKET_CAP_RATE_DEFAULTS["Conservative-Default"]),
  };
}

/** Resolve a state code to its market cap rate. Pure. */
export function getMarketCapRate(
  state: string | null | undefined,
  capRates: Record<MarketTier, number> = readMarketCapRates(),
): { rate: number; tier: MarketTier } {
  const tier = marketTierForState(state);
  return { rate: capRates[tier], tier };
}

export interface FlipperMaoInputs {
  arvMid: number | null;
  estRehab: number | null;
  wholesaleFee: number | null;
}

/**
 * Pure: V2.1 flipper floor math.
 *   flipper_mao = MAX(arv_mid − rehab − wholesale_fee, 0)
 * Returns null when arvMid or estRehab is missing. wholesaleFee
 * defaults to 15000 (Bible v3 §9) when null.
 */
export function computeFlipperMao(opts: FlipperMaoInputs): number | null {
  const wholesale = opts.wholesaleFee ?? 15000;
  if (opts.arvMid == null || opts.estRehab == null) return null;
  return Math.max(opts.arvMid - opts.estRehab - wholesale, 0);
}

export interface LandlordMaoInputs {
  monthlyRent: number | null;
  capRate: number;
  estRehab: number | null;
  wholesaleFee: number | null;
}

/**
 * Pure: landlord-track floor math (cap-rate × annual rent).
 *   gross_annual = monthly_rent × 12
 *   landlord_max_offer = gross_annual / cap_rate
 *   landlord_mao = MAX(landlord_max_offer − rehab − wholesale_fee, 0)
 * Returns null when monthlyRent or estRehab is missing, or when
 * cap_rate is invalid (zero/negative/non-finite). wholesaleFee
 * defaults to 15000 when null.
 *
 * This is the simpler V2.1-floor variant. The Pricing Agent's
 * lib/pricing-math.computeDualTrackPricing applies vacancy + opex +
 * closing_costs + buyer_profit on top — that's the operative pricing
 * recommendation; this is the never-go-below ceiling for the
 * dual-track floor in mao-range.ts.
 */
export function computeLandlordMao(opts: LandlordMaoInputs): number | null {
  const wholesale = opts.wholesaleFee ?? 15000;
  if (
    opts.monthlyRent == null ||
    opts.monthlyRent <= 0 ||
    opts.estRehab == null ||
    !Number.isFinite(opts.capRate) ||
    opts.capRate <= 0
  ) {
    return null;
  }
  const grossAnnual = opts.monthlyRent * 12;
  const landlordMaxOffer = grossAnnual / opts.capRate;
  return Math.max(landlordMaxOffer - opts.estRehab - wholesale, 0);
}

export type DominantTrack = "flipper" | "landlord" | "tie" | "neither";

export interface DualTrackInputs {
  arvMid: number | null;
  estRehab: number | null;
  wholesaleFee: number | null;
  monthlyRent: number | null;
  state: string | null | undefined;
  /** Caller-supplied cap rates (testing override). */
  capRates?: Record<MarketTier, number>;
}

export interface DualTrackResult {
  flipper_mao: number | null;
  landlord_mao: number | null;
  dominant_track: DominantTrack;
  /** The higher of flipper_mao / landlord_mao, used as the floor by
   *  mao-range.ts. Null when both tracks return null. */
  dominant_value: number | null;
  modifier_inputs: {
    arv_mid: number | null;
    est_rehab: number | null;
    wholesale_fee: number;
    monthly_rent: number | null;
    cap_rate: number;
    cap_rate_tier: MarketTier;
    state: string | null | undefined;
  };
}

/** Tracks within $1000 of each other are treated as a tie (avoids
 *  rounding-induced flips between equivalent pricing strategies). */
const TIE_THRESHOLD = 1000;

/**
 * Pure: run both tracks, pick the higher as dominant. Tie when within
 * $1000 of each other. "Neither" when both tracks return null (no
 * inputs to compute either).
 *
 * Flipper-only when monthly_rent is missing — landlord_mao is null
 * and dominant defaults to flipper regardless of value (including
 * zero, which is the clamped floor when arvMid < rehab + wholesale).
 */
export function computeDualTrack(opts: DualTrackInputs): DualTrackResult {
  const wholesale = opts.wholesaleFee ?? 15000;
  const { rate: capRate, tier: capRateTier } = getMarketCapRate(opts.state, opts.capRates);

  const flipper = computeFlipperMao({
    arvMid: opts.arvMid,
    estRehab: opts.estRehab,
    wholesaleFee: opts.wholesaleFee,
  });
  const landlord = computeLandlordMao({
    monthlyRent: opts.monthlyRent,
    capRate,
    estRehab: opts.estRehab,
    wholesaleFee: opts.wholesaleFee,
  });

  let dominantTrack: DominantTrack;
  let dominantValue: number | null;
  if (flipper == null && landlord == null) {
    dominantTrack = "neither";
    dominantValue = null;
  } else if (landlord == null) {
    dominantTrack = "flipper";
    dominantValue = flipper;
  } else if (flipper == null) {
    dominantTrack = "landlord";
    dominantValue = landlord;
  } else if (Math.abs(flipper - landlord) < TIE_THRESHOLD) {
    dominantTrack = "tie";
    dominantValue = Math.max(flipper, landlord);
  } else if (landlord > flipper) {
    dominantTrack = "landlord";
    dominantValue = landlord;
  } else {
    dominantTrack = "flipper";
    dominantValue = flipper;
  }

  return {
    flipper_mao: flipper,
    landlord_mao: landlord,
    dominant_track: dominantTrack,
    dominant_value: dominantValue,
    modifier_inputs: {
      arv_mid: opts.arvMid,
      est_rehab: opts.estRehab,
      wholesale_fee: wholesale,
      monthly_rent: opts.monthlyRent,
      cap_rate: capRate,
      cap_rate_tier: capRateTier,
      state: opts.state,
    },
  };
}
