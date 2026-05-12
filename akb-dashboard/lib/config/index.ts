// Typed config loader. Briefing §17 — configuration as data, not code.
// JSONs in this folder are the single source of tunables. Each carries a
// `last_updated` + `source` field. When two docs disagree, we encode the
// working assumption here and surface the conflict to Alex via audit log.

import rehabRatesJson from "./rehab_rates.json";
import arvFilterJson from "./arv_filter.json";
import validationCasesJson from "./validation_cases.json";

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
  outputs: {
    include_excluded_comps: boolean;
    include_filter_quality_label: boolean;
  };
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

export const rehabRates = rehabRatesJson as unknown as RehabRates;
export const arvFilter = arvFilterJson as unknown as ArvFilter;
export const validationCases = validationCasesJson as unknown as ValidationCases;

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
