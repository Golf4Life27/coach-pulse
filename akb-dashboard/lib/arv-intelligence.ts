// Phase 4A — ARV Intelligence Engine.
//
// Pure logic for taking a list of RentCast sale comparables + a subject
// property's basic facts and producing a comp-driven ARV band per the
// methodology in Bible v3 §9.2 + Crawler Roadmap §K:
//
//   ARV = subject_sqft × avg(comp $/sqft)
//
// "Renovated comp filtering, reject distressed/cash/LLC sales" is mandated
// in Bible v3 but RentCast doesn't expose buyer entity or cash-vs-financed.
// We approximate with $/sqft outlier trimming (see arv_filter.json), then
// surface both raw and filtered numbers so Alex (or the Pricing Agent) can
// see what was excluded. Briefing §17 — agents never silently pick a
// winner; conflicts are events.

import type { RentCastSaleComp } from "./rentcast";
import { arvFilter } from "./config";
import { median as medianOf } from "./rentcast";

export interface ArvSubject {
  zip: string;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  condition_target?: string | null;
}

export interface ArvCompUsed {
  price: number;
  sqft: number | null;
  per_sqft: number;
  distance: number | null;
  sale_date: string | null;
  beds: number | null;
  bathrooms: number | null;
  days_on_market: number | null;
  excluded_reason?: string;
}

export type ArvConfidence = "HIGH" | "MED" | "LOW";

export interface ArvIntelligenceResult {
  // Subject echo
  zip: string;
  subject: ArvSubject;
  // Headline numbers
  arv_mid: number | null;
  arv_low: number | null;
  arv_high: number | null;
  avg_per_sqft: number | null;
  // Sample stats
  comp_count_raw: number;
  comp_count_used: number;
  comp_count_excluded: number;
  // Confidence
  confidence: ArvConfidence;
  confidence_score: number; // 0-100
  // Transparency
  comps_used: ArvCompUsed[];
  comps_excluded: ArvCompUsed[];
  methodology_notes: string[];
  filter_quality: "clean" | "noisy" | "thin";
  computed_at: string;
}

interface FilterStage {
  comp: RentCastSaleComp;
  excluded_reason?: string;
}

function safePerSqft(c: RentCastSaleComp): number | null {
  if (c.price == null || c.price <= 0) return null;
  if (c.squareFootage == null || c.squareFootage <= 0) return null;
  return c.price / c.squareFootage;
}

function compToUsed(c: RentCastSaleComp, reason?: string): ArvCompUsed {
  const per = safePerSqft(c);
  return {
    price: c.price ?? 0,
    sqft: c.squareFootage,
    per_sqft: per ?? 0,
    distance: c.distance,
    sale_date: c.saleDate,
    beds: c.bedrooms,
    bathrooms: c.bathrooms,
    days_on_market: c.daysOnMarket,
    excluded_reason: reason,
  };
}

function applyBasicFilters(
  raw: RentCastSaleComp[],
  subject: ArvSubject,
): FilterStage[] {
  const cfg = arvFilter.comp_filters;
  const cutoffMs = Date.now() - cfg.max_age_days * 24 * 60 * 60_000;

  return raw.map<FilterStage>((c) => {
    if (c.price == null || c.price <= 0) {
      return { comp: c, excluded_reason: "no_price" };
    }
    if (c.distance != null && c.distance > cfg.max_distance_miles) {
      return { comp: c, excluded_reason: `distance>${cfg.max_distance_miles}mi` };
    }
    if (c.saleDate) {
      const t = new Date(c.saleDate).getTime();
      if (!isNaN(t) && t < cutoffMs) {
        return { comp: c, excluded_reason: `older_than_${cfg.max_age_days}d` };
      }
    }
    if (subject.sqft != null && subject.sqft > 0 && c.squareFootage != null) {
      const ratio = c.squareFootage / subject.sqft;
      if (ratio < cfg.sqft_ratio_min || ratio > cfg.sqft_ratio_max) {
        return { comp: c, excluded_reason: `sqft_ratio=${ratio.toFixed(2)}` };
      }
    }
    if (
      cfg.beds_exact_match_required &&
      subject.beds != null &&
      c.bedrooms != null &&
      c.bedrooms !== subject.beds
    ) {
      return { comp: c, excluded_reason: `beds_mismatch_${c.bedrooms}_vs_${subject.beds}` };
    }
    return { comp: c };
  });
}

function applyDistressedProxy(stages: FilterStage[]): FilterStage[] {
  const cfg = arvFilter.distressed_proxy;
  const surviving = stages.filter((s) => !s.excluded_reason);
  const persqft = surviving
    .map((s) => safePerSqft(s.comp))
    .filter((p): p is number => p != null && p > 0);

  if (persqft.length < cfg.apply_only_if_zip_has_at_least_comps) {
    return stages; // Not enough data to call outliers — leave alone.
  }

  const med = medianOf(persqft);
  if (med == null || med <= 0) return stages;
  const floor = med * cfg.drop_below_fraction_of_zip_median;
  const ceiling = med * cfg.drop_above_fraction_of_zip_median;

  return stages.map((s) => {
    if (s.excluded_reason) return s;
    const p = safePerSqft(s.comp);
    if (p == null) return { ...s, excluded_reason: "no_per_sqft" };
    if (p < floor) {
      return {
        ...s,
        excluded_reason: `$/sqft=${Math.round(p)} below ${Math.round(floor)} (${(cfg.drop_below_fraction_of_zip_median * 100).toFixed(0)}% of ZIP median ${Math.round(med)})`,
      };
    }
    if (p > ceiling) {
      return {
        ...s,
        excluded_reason: `$/sqft=${Math.round(p)} above ${Math.round(ceiling)} (${(cfg.drop_above_fraction_of_zip_median * 100).toFixed(0)}% of ZIP median ${Math.round(med)})`,
      };
    }
    return s;
  });
}

function gradeConfidence(usedCount: number): { confidence: ArvConfidence; score: number } {
  const cfg = arvFilter.comp_filters;
  if (usedCount >= cfg.min_comps_for_high_confidence) {
    return { confidence: "HIGH", score: 85 };
  }
  if (usedCount >= cfg.min_comps_for_med_confidence) {
    return { confidence: "MED", score: 70 };
  }
  if (usedCount > 0) return { confidence: "LOW", score: 50 };
  return { confidence: "LOW", score: 25 };
}

function gradeFilterQuality(rawCount: number, usedCount: number): "clean" | "noisy" | "thin" {
  if (usedCount === 0) return "thin";
  if (rawCount === 0) return "thin";
  const keptFraction = usedCount / rawCount;
  if (usedCount < 3) return "thin";
  if (keptFraction < 0.4) return "noisy";
  return "clean";
}

export function computeArvIntelligence(
  raw: RentCastSaleComp[],
  subject: ArvSubject,
): ArvIntelligenceResult {
  const notes: string[] = [];
  notes.push(
    `Filter config: window=${arvFilter.comp_filters.max_age_days}d, distance<${arvFilter.comp_filters.max_distance_miles}mi, sqft ratio ${arvFilter.comp_filters.sqft_ratio_min}-${arvFilter.comp_filters.sqft_ratio_max}, beds_exact=${arvFilter.comp_filters.beds_exact_match_required}.`,
  );
  notes.push(
    `Distressed/cash proxy: drop comps with $/sqft <${(arvFilter.distressed_proxy.drop_below_fraction_of_zip_median * 100).toFixed(0)}% or >${(arvFilter.distressed_proxy.drop_above_fraction_of_zip_median * 100).toFixed(0)}% of ZIP median (RentCast doesn't expose buyer entity).`,
  );

  const stage1 = applyBasicFilters(raw, subject);
  const stage2 = applyDistressedProxy(stage1);

  const used = stage2.filter((s) => !s.excluded_reason);
  const excluded = stage2.filter((s) => s.excluded_reason);

  const persqftUsed = used
    .map((s) => safePerSqft(s.comp))
    .filter((p): p is number => p != null && p > 0);
  const avgPerSqft = persqftUsed.length
    ? persqftUsed.reduce((a, b) => a + b, 0) / persqftUsed.length
    : null;

  let arvMid: number | null = null;
  let arvLow: number | null = null;
  let arvHigh: number | null = null;
  if (avgPerSqft != null && subject.sqft != null && subject.sqft > 0) {
    arvMid = Math.round(subject.sqft * avgPerSqft);
    const sorted = [...persqftUsed].sort((a, b) => a - b);
    const lowPsf = sorted[0];
    const highPsf = sorted[sorted.length - 1];
    arvLow = Math.round(subject.sqft * lowPsf);
    arvHigh = Math.round(subject.sqft * highPsf);
  }

  const { confidence, score } = gradeConfidence(used.length);
  const filterQuality = gradeFilterQuality(raw.length, used.length);

  if (subject.sqft == null || subject.sqft <= 0) {
    notes.push("subject_sqft missing — cannot project ARV from $/sqft. Returning $/sqft band only.");
  }
  if (used.length === 0) {
    notes.push("No comps survived filters. Hold and surface to Alex.");
  }

  return {
    zip: subject.zip,
    subject,
    arv_mid: arvMid,
    arv_low: arvLow,
    arv_high: arvHigh,
    avg_per_sqft: avgPerSqft != null ? Math.round(avgPerSqft) : null,
    comp_count_raw: raw.length,
    comp_count_used: used.length,
    comp_count_excluded: excluded.length,
    confidence,
    confidence_score: score,
    comps_used: used.map((s) => compToUsed(s.comp)),
    comps_excluded: arvFilter.outputs.include_excluded_comps
      ? excluded.map((s) => compToUsed(s.comp, s.excluded_reason))
      : [],
    methodology_notes: notes,
    filter_quality: filterQuality,
    computed_at: new Date().toISOString(),
  };
}
