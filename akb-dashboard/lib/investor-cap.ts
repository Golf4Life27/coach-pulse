// Investor-required cap rate — the OPERATIVE cap for landlord MAO.
// @agent: appraiser
//
// Corrected 2026-06-05 (operator): the operative cap must be a SOURCED,
// conservatively-high INVESTOR-REQUIRED cap — what a buy-hold investor
// demands to ACQUIRE — NOT the retail market-implied cap (RentCast
// median-sale ÷ rent), which is retail value, AVM-contaminated in
// non-disclosure TX, and overstates MAO ~30-50%.
//
// This module does NOT free-hand a single number that drives offers. It
// surfaces a CONSERVATIVE CANDIDATE BAND per market tier — a confirmation
// surface for Maverick/operator to validate against real investor
// underwriting data. No candidate becomes operative until confirmed; the
// landlord-mao report computes a single operative MAO only when an
// explicit confirmed cap is supplied, otherwise it HOLDs and shows the
// band sensitivity. Investor-required caps sit ABOVE the retail
// market-implied cap (investors demand an acquisition premium), so the
// floor check requires investor_cap ≥ market_implied_cap.
//
// Pure + unit-tested.

export const INVESTOR_CAP_BASIS_SOURCE =
  "Conservative SFR-investor ACQUISITION underwriting band — PENDING operator/Maverick confirmation against real investor data. " +
  "Stabilized SFR investor-required caps run materially ABOVE retail market-implied caps; value-add/wholesale acquisitions demand " +
  "the high end. The band below is a CONFIRMATION SURFACE, not a system default that drives offers.";

export type MarketTier = "tx_metro" | "tn_memphis" | "default";

/** Conservative candidate investor-required caps (fractions), HIGHER =
 *  more conservative (lower MAO). Per coarse market tier. These are
 *  CANDIDATES pending confirmation, never silent defaults. */
export const INVESTOR_CAP_CANDIDATES: Record<MarketTier, readonly number[]> = {
  tx_metro: [0.08, 0.09, 0.10],     // San Antonio / TX secondary metros
  tn_memphis: [0.10, 0.11, 0.12],   // Memphis — higher-yield / higher-risk
  default: [0.09, 0.10, 0.11],
};

/** Pure: coarse market tier from state (+ zip). Conservative + explicit;
 *  extend as markets are added. */
export function marketTierFor(state: string | null | undefined, _zip?: string | null): MarketTier {
  const s = (state ?? "").trim().toUpperCase();
  if (s === "TN") return "tn_memphis";
  if (s === "TX") return "tx_metro";
  return "default";
}

export interface InvestorCapBand {
  tier: MarketTier;
  candidates: readonly number[];
  /** The most-conservative (highest) candidate — surfaced as the
   *  recommended starting point for confirmation (lowest MAO). */
  conservativeHigh: number;
  source: string;
}

export function investorCapBand(state: string | null | undefined, zip?: string | null): InvestorCapBand {
  const tier = marketTierFor(state, zip);
  const candidates = INVESTOR_CAP_CANDIDATES[tier];
  return {
    tier,
    candidates,
    conservativeHigh: Math.max(...candidates),
    source: INVESTOR_CAP_BASIS_SOURCE,
  };
}

export interface CapFloorCheck {
  ok: boolean;
  reason: string;
}

/** Pure: the operative investor cap must be ≥ the retail market-implied
 *  cap (investors demand an acquisition premium over retail). A
 *  candidate BELOW the market-implied floor is too aggressive (would
 *  over-pay vs retail) and is flagged. */
export function checkCapFloor(
  investorCap: number,
  marketImpliedCap: number | null,
): CapFloorCheck {
  if (marketImpliedCap == null) {
    return { ok: true, reason: "no market-implied floor available (RentCast /markets unsourced) — sanity-check skipped" };
  }
  if (investorCap >= marketImpliedCap) {
    return {
      ok: true,
      reason: `investor cap ${(investorCap * 100).toFixed(2)}% ≥ market-implied floor ${(marketImpliedCap * 100).toFixed(2)}% — conservative`,
    };
  }
  return {
    ok: false,
    reason: `investor cap ${(investorCap * 100).toFixed(2)}% is BELOW the market-implied floor ${(marketImpliedCap * 100).toFixed(2)}% — too aggressive (would imply paying above retail-justified value); raise the cap`,
  };
}
