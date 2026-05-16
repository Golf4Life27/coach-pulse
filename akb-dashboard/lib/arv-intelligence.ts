// Phase 4A — ARV Intelligence Engine.
//
// Pure logic for taking RentCast sale comparables + a subject's basic
// facts and producing a comp-driven ARV band per Bible v3 §9.2.
//
// As of 5/12 this engine produces BOTH:
//
//   arv_as_is        — what the RentCast comp cluster represents directly
//                      (subject_sqft × avg($/sqft of kept comps))
//
//   arv_renovated    — what an after-rehab retail buyer would pay,
//                      derived by one of three paths depending on data:
//
//     (1) comp_cluster_bimodal_upper — bimodal $/sqft distribution
//         detected; keep the upper cluster (renovated retail) when
//         condition_target ∈ {good, renovated}.
//
//     (2) comp_cluster_unimodal — single cluster, and the market's
//         arv_uplift.data_state_default = "renovated" (SA/Dallas/Houston).
//         The cluster IS already renovated retail. arv_renovated mirrors
//         arv_as_is — no uplift.
//
//     (3) uplift_model — single cluster, and the market's data_state_default
//         = "as_is" (Detroit/Memphis). The cluster represents distressed
//         wholesale flips within RentCast's radius; the renovated retail
//         cluster doesn't appear in the response. Apply:
//             arv_renovated = arv_as_is + (rehab_mid × multiplier)
//
//   When BOTH (1) and (3) produce a value (bimodal upper cluster exists
//   AND market is as_is by default), the engine computes both, returns
//   the average as the consensus headline, and flags cross-method
//   disagreement >threshold_pct so the audit/morning-brief layer can
//   surface it. Per the Positive Confirmation Principle — agents never
//   silently pick a winner; conflicts are events.
//
// The headline (arv_mid / arv_low / arv_high) is chosen by condition_target:
//   condition_target ∈ {good, renovated}  → arv_renovated band
//   condition_target ∈ {fair, poor, as_is, distressed, null} → arv_as_is band
//
// Existing dashboard fields read arv_mid — they'll automatically get the
// RENOVATED number in Detroit/Memphis after this commit, which is what
// the 65% rule + dual-track buyer math is calibrated against. This is a
// deliberate behavior change: prior commits wrote as-is ARV into Real_ARV_*
// in bimodal markets, which understated MAO.

import type { RentCastSaleComp } from "./rentcast";
import { arvFilter, arvUpliftForZip, bimodalGapThresholdForZip } from "./config";
import { median as medianOf } from "./rentcast";

export interface ArvSubject {
  zip: string;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  condition_target?: string | null;
  rehab_mid?: number | null;
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
  cluster?: "lower" | "upper";
  excluded_reason?: string;
}

export type ArvConfidence = "HIGH" | "MED" | "LOW";

export type ArvBandMethod =
  | "comp_cluster_unimodal"
  | "comp_cluster_bimodal_upper"
  | "comp_cluster_bimodal_lower"
  | "uplift_model"
  | "consensus"
  | null;

export interface ArvBand {
  low: number | null;
  mid: number | null;
  high: number | null;
  method: ArvBandMethod;
  cluster_size?: number;
  uplift_multiplier?: number;
  uplift_rehab_input?: number;
}

export interface ArvCrossMethodDisagreement {
  fired: boolean;
  cluster_mid: number | null;
  uplift_mid: number | null;
  delta_pct: number | null;
  threshold_pct: number;
}

export interface ArvIntelligenceResult {
  zip: string;
  subject: ArvSubject;
  condition_target_resolved: "renovated" | "as_is";
  data_state_default: "renovated" | "as_is";
  market: string;

  arv_as_is: ArvBand;
  arv_renovated: ArvBand;

  // Headline — picked by condition_target_resolved
  arv_mid: number | null;
  arv_low: number | null;
  arv_high: number | null;
  arv_method: ArvBandMethod;

  cross_method_disagreement: ArvCrossMethodDisagreement;

  avg_per_sqft: number | null;
  comp_count_raw: number;
  comp_count_used: number;
  comp_count_excluded: number;

  confidence: ArvConfidence;
  confidence_score: number;

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

function compToUsed(
  c: RentCastSaleComp,
  reason?: string,
  cluster?: "lower" | "upper",
): ArvCompUsed {
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
    cluster,
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
    return stages;
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

interface BimodalSplit {
  lower: FilterStage[];
  upper: FilterStage[];
  gapRatio: number;
  splitAtPersqft: number;
  splitNextPersqft: number;
}

function detectBimodal(
  stages: FilterStage[],
  gapThreshold: number,
  minClusterSize: number,
): BimodalSplit | null {
  const survivingWithPer = stages
    .filter((s) => !s.excluded_reason)
    .map((s) => ({ stage: s, persqft: safePerSqft(s.comp) }))
    .filter((x): x is { stage: FilterStage; persqft: number } => x.persqft != null && x.persqft > 0)
    .sort((a, b) => a.persqft - b.persqft);

  if (survivingWithPer.length < minClusterSize * 2) return null;

  let maxGapIdx = -1;
  let maxGapRatio = 0;
  for (let i = 0; i < survivingWithPer.length - 1; i++) {
    const gap = (survivingWithPer[i + 1].persqft - survivingWithPer[i].persqft) / survivingWithPer[i].persqft;
    if (gap > maxGapRatio) {
      maxGapRatio = gap;
      maxGapIdx = i;
    }
  }

  if (maxGapRatio < gapThreshold) return null;

  const lower = survivingWithPer.slice(0, maxGapIdx + 1).map((x) => x.stage);
  const upper = survivingWithPer.slice(maxGapIdx + 1).map((x) => x.stage);

  if (lower.length < minClusterSize || upper.length < minClusterSize) return null;

  return {
    lower,
    upper,
    gapRatio: maxGapRatio,
    splitAtPersqft: survivingWithPer[maxGapIdx].persqft,
    splitNextPersqft: survivingWithPer[maxGapIdx + 1].persqft,
  };
}

function bandFromStages(
  stages: FilterStage[],
  sqft: number | null | undefined,
  method: ArvBandMethod,
): ArvBand {
  const persqft = stages
    .map((s) => safePerSqft(s.comp))
    .filter((p): p is number => p != null && p > 0);
  if (persqft.length === 0 || sqft == null || sqft <= 0) {
    return { low: null, mid: null, high: null, method, cluster_size: stages.length };
  }
  const avg = persqft.reduce((a, b) => a + b, 0) / persqft.length;
  const sorted = [...persqft].sort((a, b) => a - b);
  return {
    low: Math.round(sqft * sorted[0]),
    mid: Math.round(sqft * avg),
    high: Math.round(sqft * sorted[sorted.length - 1]),
    method,
    cluster_size: stages.length,
  };
}

function resolveConditionTarget(t: string | null | undefined): "renovated" | "as_is" {
  if (!t) return "renovated"; // Agent default — ARV math targets renovated value.
  const lower = t.toLowerCase().trim();
  if (lower === "good" || lower === "renovated" || lower === "excellent") {
    return "renovated";
  }
  return "as_is";
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

function downgradeConfidence(c: ArvConfidence): ArvConfidence {
  if (c === "HIGH") return "MED";
  if (c === "MED") return "LOW";
  return "LOW";
}

function gradeFilterQuality(rawCount: number, usedCount: number): "clean" | "noisy" | "thin" {
  if (usedCount === 0) return "thin";
  if (rawCount === 0) return "thin";
  const keptFraction = usedCount / rawCount;
  if (usedCount < 3) return "thin";
  if (keptFraction < 0.4) return "noisy";
  return "clean";
}

function emptyBand(method: ArvBandMethod): ArvBand {
  return { low: null, mid: null, high: null, method };
}

export function computeArvIntelligence(
  raw: RentCastSaleComp[],
  subject: ArvSubject,
): ArvIntelligenceResult {
  const notes: string[] = [];
  const condition_target_resolved = resolveConditionTarget(subject.condition_target);
  const uplift = arvUpliftForZip(subject.zip);
  const bimodalGap = bimodalGapThresholdForZip(subject.zip);

  notes.push(
    `Filter config: window=${arvFilter.comp_filters.max_age_days}d, distance<${arvFilter.comp_filters.max_distance_miles}mi, sqft ratio ${arvFilter.comp_filters.sqft_ratio_min}-${arvFilter.comp_filters.sqft_ratio_max}, beds_exact=${arvFilter.comp_filters.beds_exact_match_required}.`,
  );
  notes.push(
    `Distressed/cash proxy: drop comps with $/sqft <${(arvFilter.distressed_proxy.drop_below_fraction_of_zip_median * 100).toFixed(0)}% or >${(arvFilter.distressed_proxy.drop_above_fraction_of_zip_median * 100).toFixed(0)}% of ZIP median (unimodal-only).`,
  );
  notes.push(
    `Market ${uplift.market}: data_state_default=${uplift.data_state_default}, uplift multiplier ${uplift.multiplier}×. condition_target=${condition_target_resolved}.`,
  );

  const stage1 = applyBasicFilters(raw, subject);

  // Bimodal detection runs BEFORE the distressed_proxy ceiling — if the
  // upper cluster is what we want (renovated retail) we don't want the
  // 1.80× ZIP-median ceiling to delete it as an outlier.
  const bimodal = detectBimodal(
    stage1,
    bimodalGap,
    arvFilter.bimodal_detection.min_cluster_size,
  );

  let stagesUsedForAsIs: FilterStage[];
  let stagesUsedForRenovatedCluster: FilterStage[] | null = null;

  if (bimodal) {
    notes.push(
      `Bimodal $/sqft distribution detected: gap ${(bimodal.gapRatio * 100).toFixed(0)}% (threshold ${(bimodalGap * 100).toFixed(0)}%) between $${Math.round(bimodal.splitAtPersqft)}/sqft and $${Math.round(bimodal.splitNextPersqft)}/sqft. Lower cluster=${bimodal.lower.length} comps, upper cluster=${bimodal.upper.length} comps.`,
    );
    // As-is band always derives from lower cluster when bimodal.
    stagesUsedForAsIs = bimodal.lower;
    stagesUsedForRenovatedCluster = bimodal.upper;
  } else {
    // Unimodal — run distressed_proxy outlier trim on the whole set.
    const stage2 = applyDistressedProxy(stage1);
    stagesUsedForAsIs = stage2.filter((s) => !s.excluded_reason);
    notes.push("Unimodal $/sqft distribution — distressed/cash outlier trim applied.");
  }

  // ── Compute as-is band (always)
  const asIsMethod: ArvBandMethod = bimodal
    ? "comp_cluster_bimodal_lower"
    : "comp_cluster_unimodal";
  const arv_as_is = bandFromStages(stagesUsedForAsIs, subject.sqft, asIsMethod);

  // ── Compute renovated band (path depends on data + market)
  let arv_renovated: ArvBand = emptyBand(null);
  let uplift_mid_candidate: number | null = null;
  let cluster_mid_candidate: number | null = null;
  let cluster_band: ArvBand | null = null;

  // Path 1: bimodal upper cluster (when present + condition_target=renovated)
  if (stagesUsedForRenovatedCluster && condition_target_resolved === "renovated") {
    cluster_band = bandFromStages(
      stagesUsedForRenovatedCluster,
      subject.sqft,
      "comp_cluster_bimodal_upper",
    );
    cluster_mid_candidate = cluster_band.mid;
    notes.push(
      `Renovated path A: bimodal upper cluster → mid $${cluster_mid_candidate?.toLocaleString() ?? "—"}.`,
    );
  }

  // Path 3: uplift model — fires when market data_state_default=as_is AND
  // we have a rehab number AND condition_target=renovated.
  if (
    condition_target_resolved === "renovated" &&
    uplift.data_state_default === "as_is" &&
    subject.rehab_mid != null &&
    subject.rehab_mid > 0 &&
    arv_as_is.mid != null
  ) {
    uplift_mid_candidate = Math.round(arv_as_is.mid + subject.rehab_mid * uplift.multiplier);
    const upliftAmount = subject.rehab_mid * uplift.multiplier;
    notes.push(
      `Renovated path B (uplift): ARV_as_is $${arv_as_is.mid.toLocaleString()} + rehab $${subject.rehab_mid.toLocaleString()} × ${uplift.multiplier}× = $${uplift_mid_candidate.toLocaleString()}.`,
    );
    if (arv_renovated.method == null) {
      // Project a band by applying the same uplift to low/high of the as-is band.
      arv_renovated = {
        low: arv_as_is.low != null ? Math.round(arv_as_is.low + upliftAmount) : null,
        mid: uplift_mid_candidate,
        high: arv_as_is.high != null ? Math.round(arv_as_is.high + upliftAmount) : null,
        method: "uplift_model",
        uplift_multiplier: uplift.multiplier,
        uplift_rehab_input: subject.rehab_mid,
      };
    }
  } else if (
    condition_target_resolved === "renovated" &&
    uplift.data_state_default === "as_is" &&
    (subject.rehab_mid == null || subject.rehab_mid <= 0)
  ) {
    notes.push(
      `Renovated path B (uplift) SKIPPED — market ${uplift.market} defaults to as_is data but no rehab_mid provided. Arv_renovated will fall back to as_is mirror.`,
    );
  }

  // Headline pick + consensus when both paths produced numbers.
  const threshold_pct = arvFilter.cross_method_disagreement.threshold_pct;
  let disagreement_fired = false;
  let delta_pct: number | null = null;

  if (cluster_mid_candidate != null && uplift_mid_candidate != null) {
    // Both paths produced a renovated estimate — surface BOTH, headline = consensus average.
    const avg = Math.round((cluster_mid_candidate + uplift_mid_candidate) / 2);
    const baseline = Math.max(cluster_mid_candidate, uplift_mid_candidate);
    delta_pct = Math.abs(cluster_mid_candidate - uplift_mid_candidate) / baseline;
    disagreement_fired = delta_pct > threshold_pct;
    arv_renovated = {
      low: cluster_band?.low ?? null,
      mid: avg,
      high: cluster_band?.high ?? null,
      method: "consensus",
      cluster_size: cluster_band?.cluster_size,
      uplift_multiplier: uplift.multiplier,
      uplift_rehab_input: subject.rehab_mid ?? undefined,
    };
    notes.push(
      `Renovated headline = consensus avg($${cluster_mid_candidate.toLocaleString()}, $${uplift_mid_candidate.toLocaleString()}) = $${avg.toLocaleString()}. Delta ${(delta_pct * 100).toFixed(1)}% vs ${(threshold_pct * 100).toFixed(0)}% threshold → ${disagreement_fired ? "DISAGREEMENT FLAGGED" : "within tolerance"}.`,
    );
  } else if (cluster_mid_candidate != null) {
    arv_renovated = cluster_band!;
  }
  // else uplift-only case is already populated above.

  // Path 2: unimodal renovated mirror — when market is data_state_default=renovated,
  // arv_renovated mirrors arv_as_is (the cluster IS already renovated retail).
  if (
    arv_renovated.method == null &&
    condition_target_resolved === "renovated" &&
    uplift.data_state_default === "renovated"
  ) {
    arv_renovated = {
      ...arv_as_is,
      method: arv_as_is.method, // inherits comp_cluster_unimodal / _bimodal_lower
    };
    notes.push(
      `Renovated path C (mirror): ${uplift.market} data_state=renovated → arv_renovated = arv_as_is ($${arv_as_is.mid?.toLocaleString() ?? "—"}). No uplift applied.`,
    );
  }

  // Final fallback — if condition_target is renovated but we couldn't produce
  // a renovated estimate (no rehab, no upper cluster, no renovated default),
  // mirror as_is and note the limitation.
  if (arv_renovated.method == null) {
    arv_renovated = { ...arv_as_is };
    if (condition_target_resolved === "renovated") {
      notes.push(
        "Could not project to renovated (no rehab input + no upper cluster + market default=as_is). Falling back to as-is — offer math will be conservative.",
      );
    }
  }

  // ── Headline pick
  const renovatedTargeted = condition_target_resolved === "renovated";
  const headlineBand = renovatedTargeted ? arv_renovated : arv_as_is;
  const arv_mid = headlineBand.mid;
  const arv_low = headlineBand.low;
  const arv_high = headlineBand.high;
  const arv_method = headlineBand.method;

  // ── Confidence + filter quality based on the headline cluster
  const headlineStages = renovatedTargeted
    ? (stagesUsedForRenovatedCluster ?? stagesUsedForAsIs)
    : stagesUsedForAsIs;
  const usedCount = headlineStages.length;
  let { confidence, score } = gradeConfidence(usedCount);
  if (disagreement_fired) {
    const before = confidence;
    confidence = downgradeConfidence(confidence);
    score = Math.max(25, score - 20);
    notes.push(
      `Confidence downgraded ${before}→${confidence} due to cross-method disagreement.`,
    );
  }
  const filterQuality = gradeFilterQuality(raw.length, usedCount);

  const avgPerSqftAll = (() => {
    const persqft = headlineStages
      .map((s) => safePerSqft(s.comp))
      .filter((p): p is number => p != null && p > 0);
    return persqft.length ? persqft.reduce((a, b) => a + b, 0) / persqft.length : null;
  })();

  // Transparency: comps_used = headline cluster; comps_excluded = everything else
  const headlineSet = new Set(headlineStages.map((s) => s.comp));
  const allStages = bimodal ? [...bimodal.lower, ...bimodal.upper] : applyDistressedProxy(stage1);
  // For bimodal, we need to construct the same flat "all stages" list — both
  // clusters are non-excluded, but the comps NOT in the headline cluster
  // should be surfaced as "excluded" with cluster label so Alex can see.
  const comps_used: ArvCompUsed[] = headlineStages.map((s) =>
    compToUsed(s.comp, undefined, bimodal ? (renovatedTargeted ? "upper" : "lower") : undefined),
  );
  const comps_excluded: ArvCompUsed[] = arvFilter.outputs.include_excluded_comps
    ? bimodal
      ? // Show the OTHER cluster as "excluded" so the bimodal split is visible
        [
          ...bimodal.upper
            .filter((s) => !headlineSet.has(s.comp))
            .map((s) => compToUsed(s.comp, "in_upper_cluster_not_headline", "upper")),
          ...bimodal.lower
            .filter((s) => !headlineSet.has(s.comp))
            .map((s) => compToUsed(s.comp, "in_lower_cluster_not_headline", "lower")),
          ...stage1
            .filter((s) => s.excluded_reason)
            .map((s) => compToUsed(s.comp, s.excluded_reason)),
        ]
      : (allStages as FilterStage[])
          .filter((s) => s.excluded_reason)
          .map((s) => compToUsed(s.comp, s.excluded_reason))
    : [];

  if (subject.sqft == null || subject.sqft <= 0) {
    notes.push("subject_sqft missing — cannot project ARV from $/sqft.");
  }
  if (usedCount === 0) {
    notes.push("No comps survived filters for the headline cluster. Hold and surface to Alex.");
  }

  return {
    zip: subject.zip,
    subject,
    condition_target_resolved,
    data_state_default: uplift.data_state_default,
    market: uplift.market,

    arv_as_is,
    arv_renovated,

    arv_mid,
    arv_low,
    arv_high,
    arv_method,

    cross_method_disagreement: {
      fired: disagreement_fired,
      cluster_mid: cluster_mid_candidate,
      uplift_mid: uplift_mid_candidate,
      delta_pct,
      threshold_pct,
    },

    avg_per_sqft: avgPerSqftAll != null ? Math.round(avgPerSqftAll) : null,
    comp_count_raw: raw.length,
    comp_count_used: usedCount,
    comp_count_excluded: raw.length - usedCount,

    confidence,
    confidence_score: score,

    comps_used,
    comps_excluded,
    methodology_notes: notes,
    filter_quality: filterQuality,
    computed_at: new Date().toISOString(),
  };
}
