// Typed config loader. Briefing §17 — configuration as data, not code.
// JSONs in this folder are the single source of tunables. Each carries a
// `last_updated` + `source` field. When two docs disagree, we encode the
// working assumption here and surface the conflict to Alex via audit log.

import rehabRatesJson from "./rehab_rates.json";
import arvFilterJson from "./arv_filter.json";
import validationCasesJson from "./validation_cases.json";
import capRatesJson from "./cap_rates.json";
import pricingRulesJson from "./pricing_rules.json";
import arvUpliftJson from "./arv_uplift.json";

export interface RehabRates {
  last_updated: string;
  source: string;
  version: number;
  rates_per_sqft: Record<string, number>;
  market_multipliers: {
    _default: number;
    by_zip_prefix: Record<string, { multiplier: number; market: string }>;
  };
  scope_band_spread: {
    default_low_pct: number;
    default_high_pct: number;
    high_confidence_low_pct: number;
    high_confidence_high_pct: number;
  };
}

export interface ArvFilter {
  last_updated: string;
  source: string;
  version: number;
  comp_filters: {
    max_age_days: number;
    max_distance_miles: number;
    sqft_ratio_min: number;
    sqft_ratio_max: number;
    beds_exact_match_required: boolean;
    min_comps_for_high_confidence: number;
    min_comps_for_med_confidence: number;
  };
  distressed_proxy: {
    drop_below_fraction_of_zip_median: number;
    drop_above_fraction_of_zip_median: number;
    apply_only_if_zip_has_at_least_comps: number;
  };
  bimodal_detection: {
    default_gap_threshold: number;
    min_cluster_size: number;
    by_zip_prefix: Record<string, { gap_threshold: number }>;
  };
  cross_method_disagreement: {
    threshold_pct: number;
  };
  outputs: {
    include_excluded_comps: boolean;
    include_filter_quality_label: boolean;
  };
}

export type ArvDataStateDefault = "as_is" | "renovated";

export interface ArvUpliftEntry {
  multiplier: number;
  data_state_default: ArvDataStateDefault;
  market: string;
}

export interface ArvUplift {
  last_updated: string;
  source: string;
  version: number;
  _default: { multiplier: number; data_state_default: ArvDataStateDefault };
  by_zip_prefix: Record<string, ArvUpliftEntry>;
}

export interface ValidationCase {
  id: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  status_note: string;
  subject: {
    beds?: number;
    baths?: number;
    sqft?: number;
    condition?: string;
  };
  expectations: Record<string, unknown>;
}

export interface ValidationCases {
  last_updated: string;
  source: string;
  version: number;
  cases: ValidationCase[];
}

export interface CapRates {
  last_updated: string;
  source: string;
  version: number;
  _default: number;
  by_zip_prefix: Record<string, { cap_rate: number; market: string }>;
}

export interface PricingRules {
  last_updated: string;
  source: string;
  version: number;
  wholesale_fee: {
    floor_usd: number;
    by_zip_prefix: Record<string, { floor_usd: number; market: string }>;
  };
  closing_costs: { pct_of_arv: number };
  flipper_track: { buyer_profit_usd: number };
  landlord_track: {
    buyer_profit_usd: number;
    vacancy_pct: number;
    opex_pct_of_gross_rent: number;
  };
  dual_track_decision: { creative_finance_threshold_usd: number };
}

export const rehabRates = rehabRatesJson as unknown as RehabRates;
export const arvFilter = arvFilterJson as unknown as ArvFilter;
export const validationCases = validationCasesJson as unknown as ValidationCases;
export const capRates = capRatesJson as unknown as CapRates;
export const pricingRules = pricingRulesJson as unknown as PricingRules;
export const arvUplift = arvUpliftJson as unknown as ArvUplift;

// Market multiplier lookup by ZIP. Falls back to default when ZIP prefix
// isn't in the table. Returns both the number and the market label for
// transparent audit logging.
export function marketMultiplierForZip(zip: string | null | undefined): {
  multiplier: number;
  market: string;
} {
  if (!zip) return { multiplier: rehabRates.market_multipliers._default, market: "unknown" };
  const z = zip.trim();
  for (const [prefix, entry] of Object.entries(rehabRates.market_multipliers.by_zip_prefix)) {
    if (z.startsWith(prefix)) return entry;
  }
  return { multiplier: rehabRates.market_multipliers._default, market: "default" };
}

export function getValidationCase(id: string): ValidationCase | null {
  return validationCases.cases.find((c) => c.id === id) ?? null;
}

// Cap-rate lookup by ZIP prefix (mirrors marketMultiplierForZip).
export function capRateForZip(zip: string | null | undefined): {
  cap_rate: number;
  market: string;
} {
  if (!zip) return { cap_rate: capRates._default, market: "unknown" };
  const z = zip.trim();
  for (const [prefix, entry] of Object.entries(capRates.by_zip_prefix)) {
    if (z.startsWith(prefix)) return entry;
  }
  return { cap_rate: capRates._default, market: "default" };
}

// Wholesale-fee floor lookup. Supports per-ZIP override; falls back to
// the global floor.
export function wholesaleFeeForZip(zip: string | null | undefined): {
  floor_usd: number;
  market: string;
} {
  if (!zip) {
    return { floor_usd: pricingRules.wholesale_fee.floor_usd, market: "default" };
  }
  const z = zip.trim();
  for (const [prefix, entry] of Object.entries(pricingRules.wholesale_fee.by_zip_prefix)) {
    if (z.startsWith(prefix)) return entry;
  }
  return { floor_usd: pricingRules.wholesale_fee.floor_usd, market: "default" };
}

// ARV uplift lookup. Returns the per-market multiplier AND the
// data_state_default — the discriminator for whether RentCast's typical
// comp set in this market represents AS-IS or RENOVATED retail.
//   Detroit/Memphis → as_is (uplift fires)
//   SA/Dallas/Houston → renovated (uplift suppressed unless bimodal hides it)
export function arvUpliftForZip(zip: string | null | undefined): ArvUpliftEntry {
  if (!zip) {
    return {
      multiplier: arvUplift._default.multiplier,
      data_state_default: arvUplift._default.data_state_default,
      market: "unknown",
    };
  }
  const z = zip.trim();
  for (const [prefix, entry] of Object.entries(arvUplift.by_zip_prefix)) {
    if (z.startsWith(prefix)) return entry;
  }
  return {
    multiplier: arvUplift._default.multiplier,
    data_state_default: arvUplift._default.data_state_default,
    market: "default",
  };
}

// Bimodal-detection gap threshold by ZIP prefix.
export function bimodalGapThresholdForZip(zip: string | null | undefined): number {
  if (!zip) return arvFilter.bimodal_detection.default_gap_threshold;
  const z = zip.trim();
  for (const [prefix, entry] of Object.entries(arvFilter.bimodal_detection.by_zip_prefix)) {
    if (z.startsWith(prefix)) return entry.gap_threshold;
  }
  return arvFilter.bimodal_detection.default_gap_threshold;
}
