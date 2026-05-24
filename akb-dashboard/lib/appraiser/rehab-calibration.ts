// Phase 4B.1 — Appraiser rehab calibration (BBC 5-tier × market multiplier).
// @agent: appraiser
//
// Pure helpers for the standalone /api/agents/appraiser/rehab/[recordId]
// endpoint. Separate from `lib/rehab-calibration.ts` (Anthropic Vision
// wrapper that returns a raw $-estimate via Condition labels). This
// module calibrates the raw vision output into the BBC 5-tier model
// per Operations Bible v3 §4.2:
//
//   Cosmetic  $15/sqft total
//   Light     $22/sqft total
//   Medium    $30/sqft total
//   Heavy     $50/sqft total
//   Gut       $70/sqft total
//
// Then applies a per-market multiplier per the Phase 4B sprint brief:
//
//   TX-Metro             (SA, Dallas, Houston) ×1.00
//   TN-Distressed        (Memphis)             ×0.90
//   MI-Distressed        (Detroit)             ×0.85
//   Conservative-Default (anywhere else)       ×1.10
//
// All four multipliers are env-overridable via REHAB_MULT_TX_METRO,
// REHAB_MULT_TN_DISTRESSED, REHAB_MULT_MI_DISTRESSED, REHAB_MULT_DEFAULT.
//
// The vision call's Condition output (Good/Average/Fair/Poor/Disrepair)
// maps to BBC tier via `classifyBbcTierFromCondition`. Alternatively
// `classifyBbcTierFromRate(raw_rehab_per_sqft)` infers tier from a
// raw $/sqft if the producer (Scenario I or in-app vision) reports a
// dollar amount instead of a condition label.

export type BbcTier = "Cosmetic" | "Light" | "Medium" | "Heavy" | "Gut";

export const BBC_TIERS: BbcTier[] = ["Cosmetic", "Light", "Medium", "Heavy", "Gut"];

/** Per-Bible-v3 §4.2 anchor rates in $/sqft. */
export const BBC_ANCHOR_PER_SQFT: Record<BbcTier, number> = {
  Cosmetic: 15,
  Light: 22,
  Medium: 30,
  Heavy: 50,
  Gut: 70,
};

export type MarketTier =
  | "TX-Metro"
  | "TN-Distressed"
  | "MI-Distressed"
  | "Conservative-Default";

const MARKET_TIER_DEFAULTS: Record<MarketTier, number> = {
  "TX-Metro": 1.0,
  "TN-Distressed": 0.9,
  "MI-Distressed": 0.85,
  "Conservative-Default": 1.1,
};

/** Read multipliers from env with fall-through to defaults. Pure given env. */
export function readMarketMultipliers(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<MarketTier, number> {
  const parse = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    "TX-Metro": parse(env.REHAB_MULT_TX_METRO, MARKET_TIER_DEFAULTS["TX-Metro"]),
    "TN-Distressed": parse(env.REHAB_MULT_TN_DISTRESSED, MARKET_TIER_DEFAULTS["TN-Distressed"]),
    "MI-Distressed": parse(env.REHAB_MULT_MI_DISTRESSED, MARKET_TIER_DEFAULTS["MI-Distressed"]),
    "Conservative-Default": parse(env.REHAB_MULT_DEFAULT, MARKET_TIER_DEFAULTS["Conservative-Default"]),
  };
}

/**
 * Map a US state code to its market tier per the Phase 4B brief.
 * Defaults to Conservative-Default for any state not explicitly
 * tiered. Pure.
 */
export function marketTierForState(state: string | null | undefined): MarketTier {
  if (!state) return "Conservative-Default";
  const s = state.trim().toUpperCase();
  if (s === "TX") return "TX-Metro";
  if (s === "TN") return "TN-Distressed";
  if (s === "MI") return "MI-Distressed";
  return "Conservative-Default";
}

/**
 * Map the existing vision Condition output (Good/Average/Fair/Poor/
 * Disrepair from lib/rehab-calibration.ts) to a BBC tier. Pure.
 *
 * Mapping rationale: vision Condition reflects visual assessment;
 * BBC tier reflects cost band. The natural ordering is parallel —
 * Good→Cosmetic, Average→Light, Fair→Medium, Poor→Heavy, Disrepair→Gut.
 */
export function classifyBbcTierFromCondition(
  condition: string | null | undefined,
): BbcTier {
  const c = (condition ?? "").trim().toLowerCase();
  if (c === "good") return "Cosmetic";
  if (c === "average") return "Light";
  if (c === "fair") return "Medium";
  if (c === "poor") return "Heavy";
  if (c === "disrepair") return "Gut";
  // Unknown / null → Medium (conservative middle, neither under- nor
  // over-estimates; surfaces in audit as having defaulted).
  return "Medium";
}

/**
 * Infer BBC tier from a raw $/sqft rate (e.g., what Scenario I's
 * line items aggregate to). Pure. Boundary thresholds chosen as
 * midpoints between anchors so jitter near a tier edge classifies
 * consistently.
 */
export function classifyBbcTierFromRate(ratePerSqft: number | null | undefined): BbcTier {
  if (ratePerSqft == null || !Number.isFinite(ratePerSqft) || ratePerSqft <= 0) return "Cosmetic";
  if (ratePerSqft < 18.5) return "Cosmetic"; // midpoint of 15 and 22
  if (ratePerSqft < 26) return "Light"; // midpoint of 22 and 30
  if (ratePerSqft < 40) return "Medium"; // midpoint of 30 and 50
  if (ratePerSqft < 60) return "Heavy"; // midpoint of 50 and 70
  return "Gut";
}

/**
 * Apply per-market multiplier to a base rate. Pure. Returns the
 * calibrated $/sqft.
 */
export function applyMarketMultiplier(
  state: string | null | undefined,
  baseRatePerSqft: number,
  multipliers: Record<MarketTier, number> = readMarketMultipliers(),
): { rate: number; tier: MarketTier; multiplier: number } {
  const tier = marketTierForState(state);
  const multiplier = multipliers[tier];
  return {
    rate: Math.round(baseRatePerSqft * multiplier * 100) / 100,
    tier,
    multiplier,
  };
}

export interface RehabRangeInputs {
  sqft: number | null;
  bbcTier: BbcTier;
  state: string | null | undefined;
  /** Confidence band width as fraction of mid. Defaults to
   *  default_low_pct/default_high_pct from rehab_rates.json (0.80/1.30). */
  bandLowFraction?: number;
  bandHighFraction?: number;
  /** Multipliers override (for tests). */
  multipliers?: Record<MarketTier, number>;
}

export interface RehabRange {
  rehab_mid: number | null;
  rehab_low: number | null;
  rehab_high: number | null;
  bbc_tier: BbcTier;
  anchor_per_sqft: number;
  market_tier: MarketTier;
  market_multiplier: number;
  calibrated_rate_per_sqft: number;
  sqft: number | null;
}

const DEFAULT_BAND_LOW_FRACTION = 0.8;
const DEFAULT_BAND_HIGH_FRACTION = 1.3;

/**
 * Compute the calibrated rehab range for a subject. Pure.
 *
 *   anchor = BBC_ANCHOR_PER_SQFT[bbcTier]
 *   calibrated = anchor × market_multiplier(state)
 *   rehab_mid = round(calibrated × sqft)
 *   rehab_low = round(rehab_mid × bandLowFraction)
 *   rehab_high = round(rehab_mid × bandHighFraction)
 *
 * Returns null mid/low/high when sqft is null (cannot compute).
 */
export function computeRehabRange(opts: RehabRangeInputs): RehabRange {
  const anchor = BBC_ANCHOR_PER_SQFT[opts.bbcTier];
  const { rate: calibrated, tier: marketTier, multiplier } = applyMarketMultiplier(
    opts.state,
    anchor,
    opts.multipliers,
  );
  if (opts.sqft == null || !Number.isFinite(opts.sqft) || opts.sqft <= 0) {
    return {
      rehab_mid: null,
      rehab_low: null,
      rehab_high: null,
      bbc_tier: opts.bbcTier,
      anchor_per_sqft: anchor,
      market_tier: marketTier,
      market_multiplier: multiplier,
      calibrated_rate_per_sqft: calibrated,
      sqft: opts.sqft,
    };
  }
  const bandLow = opts.bandLowFraction ?? DEFAULT_BAND_LOW_FRACTION;
  const bandHigh = opts.bandHighFraction ?? DEFAULT_BAND_HIGH_FRACTION;
  const mid = Math.round(calibrated * opts.sqft);
  const low = Math.round(mid * bandLow);
  const high = Math.round(mid * bandHigh);
  return {
    rehab_mid: mid,
    rehab_low: low,
    rehab_high: high,
    bbc_tier: opts.bbcTier,
    anchor_per_sqft: anchor,
    market_tier: marketTier,
    market_multiplier: multiplier,
    calibrated_rate_per_sqft: calibrated,
    sqft: opts.sqft,
  };
}
