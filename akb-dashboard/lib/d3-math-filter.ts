// D3 Phase 0b — Cheap math filter.
//
// Runs over the Texted universe AFTER Phase 0a scrub has done its work.
// Pure formula-derived classification: no live API calls, no RentCast,
// no Pricing Agent. Reads Airtable cache only.
//
// Per Alex 5/13 directive: math filter runs BEFORE market re-verify.
// Math-fail records exit pipeline without burning RentCast quota.
// Math-pass-needs-refresh records are the candidate pool for Phase 0b.5
// selective Pricing Agent re-run (quota-gated).
//
// Pure function — caller decides what to do with the classification.
// Phase 0b is REPORT-ONLY: no writes are produced. Phase 0c/0d wire
// up cadence routing once Alex sees bucket counts.

import type { Listing } from "@/lib/types";
import thresholdsConfig from "@/lib/config/d3-math-thresholds.json";

// 7 mutually-exclusive buckets. Order of precedence below.
export type MathBucket =
  | "math_pass_auto"
  | "math_pass_manual"
  | "math_pass_needs_refresh"
  | "math_fail_null_inputs"
  | "math_fail_negative"
  | "math_fail_below_threshold"
  | "math_fail_list_drift";

export interface MathResult {
  recordId: string;
  bucket: MathBucket;
  reasoning: string;
  data_examined: Record<string, unknown>;
  // Math filter is read-only — no writes produced. Phase 0c/0d wire
  // cadence routing once bucket distribution is approved.
  pending_writes: null;
}

const AUTO_FLOOR = thresholdsConfig.config.auto_approve_spread_floor_usd;
const MANUAL_FLOOR = thresholdsConfig.config.manual_review_spread_floor_usd;
const LIST_DRIFT_PCT = thresholdsConfig.config.list_drift_pct_threshold;
const FRESH_HOURS = thresholdsConfig.config.pricing_input_freshness_hours;

function hoursSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / (60 * 60_000);
}

function isFinitePositive(n: number | null | undefined): n is number {
  return typeof n === "number" && isFinite(n) && n > 0;
}

/**
 * Classify a single Texted record on cheap math signals.
 * Precedence:
 *   1. Real_ARV_Median null/0 → null_inputs. Pricing Agent never ran
 *      (Investor_MAO formula returns a -$30K/-$45K default in that
 *      state because Buyer_Profit/Wholesale_Fee defaults flow through).
 *      Don't mistake the default for "math fails" — math hasn't been
 *      computed at all.
 *   2. Real_ARV_Median > 0 but Investor_MAO/Your_MAO negative → negative
 *      (real math fail: comps exist but property can't pencil)
 *   3. List price drift >=10% since Texted-time → list_drift (stale math)
 *   4. Spread below $10K → below_threshold (math says no)
 *   5. Stale Pricing Agent inputs (>30d) → needs_refresh (Phase 0b.5 cand)
 *   6. Spread $10-20K → pass_manual
 *   7. Spread >=$20K + Auto_Approve_v2=true → pass_auto
 */
export function classifyMath(listing: Listing): MathResult {
  const recordId = listing.id;
  const investor = listing.investorMao ?? null;
  const yours = listing.yourMao ?? null;
  const realArvMedian = listing.realArvMedian ?? null;
  const estRehabMid = listing.estRehabMid ?? null;
  const estRehab = listing.estRehab ?? null;
  const autoApprove = listing.autoApproveV2 === true;
  const listPrice = listing.listPrice ?? null;
  const prevListPrice = listing.prevListPrice ?? null;
  const arvAge = hoursSince(listing.arvValidatedAt);

  const baseExamined = {
    investor_mao: investor,
    your_mao: yours,
    real_arv_median: realArvMedian,
    est_rehab_mid: estRehabMid,
    est_rehab: estRehab,
    auto_approve_v2: autoApprove,
    list_price: listPrice,
    prev_list_price: prevListPrice,
    arv_validated_at: listing.arvValidatedAt,
    arv_age_hours: isFinite(arvAge) ? arvAge : null,
  };

  // 1. Pricing Agent never ran. Real_ARV_Median is the input that gates
  //    every downstream V2.1 formula. When it's null/0, Investor_MAO and
  //    Your_MAO both come back as the formula's -$30K/-$45K default
  //    (Buyer_Profit + Wholesale_Fee defaults flow through). That looks
  //    like negative math but is actually "no math run." Distinguishing
  //    these matters: null_inputs records are Phase 0b.5 candidates (run
  //    Pricing Agent), negative records are exit-pipeline.
  if (!isFinitePositive(realArvMedian)) {
    return {
      recordId,
      bucket: "math_fail_null_inputs",
      reasoning: `Real_ARV_Median=${realArvMedian} — Pricing Agent never ran (or returned no ARV). Investor_MAO=$${investor}/Your_MAO=$${yours} are the formula's default-output state, not actual math. Phase 0b.5 candidate IF quota allows; otherwise exit pipeline.`,
      data_examined: baseExamined,
      pending_writes: null,
    };
  }

  // 2. ARV exists but formulas spat out null (rare — investor or yours
  //    could be null even with positive ARV if rehab is null AND the
  //    formula short-circuits). Treat as null_inputs for safety.
  if (investor == null || yours == null) {
    return {
      recordId,
      bucket: "math_fail_null_inputs",
      reasoning: `Real_ARV_Median=$${realArvMedian} but Investor_MAO=${investor} / Your_MAO=${yours} — formula short-circuited (likely Est_Rehab null). Phase 0b.5 candidate to re-run pricing pipeline.`,
      data_examined: baseExamined,
      pending_writes: null,
    };
  }

  // 3. Real ARV exists, math ran, came out negative. Property genuinely
  //    can't pencil at any offer. Exit pipeline.
  if (investor < 0 || yours < 0) {
    return {
      recordId,
      bucket: "math_fail_negative",
      reasoning: `Real_ARV_Median=$${realArvMedian}, Investor_MAO=$${investor}, Your_MAO=$${yours}. ARV exists but math doesn't pencil. Exit pipeline.`,
      data_examined: baseExamined,
      pending_writes: null,
    };
  }

  // 3. List drift — if List_Price has dropped substantially since the
  //    Texted record was created, MAO math we ran then is stale. Don't
  //    trust Auto_Approve_v2 in this state; needs re-run with current
  //    List_Price.
  if (isFinitePositive(listPrice) && isFinitePositive(prevListPrice)) {
    const driftPct = (prevListPrice - listPrice) / prevListPrice;
    if (driftPct >= LIST_DRIFT_PCT) {
      return {
        recordId,
        bucket: "math_fail_list_drift",
        reasoning: `List_Price dropped ${(driftPct * 100).toFixed(1)}% (from $${prevListPrice} → $${listPrice}). >=${(LIST_DRIFT_PCT * 100).toFixed(0)}% drift means math we ran at Texted-time is stale — current Investor_MAO/Your_MAO not trustworthy without re-run. Phase 0b.5 candidate.`,
        data_examined: { ...baseExamined, drift_pct: driftPct, drift_threshold: LIST_DRIFT_PCT },
        pending_writes: null,
      };
    }
  }

  const spread = investor - yours;

  // 4. Below $10K spread — math fails V2.1 floor. Exit.
  if (spread < MANUAL_FLOOR) {
    return {
      recordId,
      bucket: "math_fail_below_threshold",
      reasoning: `Spread Investor_MAO($${investor}) - Your_MAO($${yours}) = $${spread}, below $${MANUAL_FLOOR} floor. V2.1 says math fails. Exit pipeline.`,
      data_examined: { ...baseExamined, spread, manual_floor: MANUAL_FLOOR },
      pending_writes: null,
    };
  }

  // 5. Stale Pricing Agent inputs — math passes today but inputs are
  //    >30 days old. Don't trust without re-run. Phase 0b.5 candidate.
  //    (Checked AFTER spread because no point re-running PA on a record
  //    that already fails math.)
  if (arvAge > FRESH_HOURS) {
    return {
      recordId,
      bucket: "math_pass_needs_refresh",
      reasoning: `Spread $${spread} passes floor, but ARV_Validated_At ${isFinite(arvAge) ? `${arvAge.toFixed(0)}hr ago` : "never set"} (>${FRESH_HOURS}hr). Inputs stale. Phase 0b.5 candidate for selective Pricing Agent re-run (quota-gated).`,
      data_examined: { ...baseExamined, spread, fresh_threshold_hours: FRESH_HOURS },
      pending_writes: null,
    };
  }

  // 6. $10-20K spread + fresh inputs → manual review.
  if (spread < AUTO_FLOOR) {
    return {
      recordId,
      bucket: "math_pass_manual",
      reasoning: `Spread $${spread} in manual-review band ($${MANUAL_FLOOR}-$${AUTO_FLOOR}). Inputs fresh. Surface to Alex for go/no-go.`,
      data_examined: { ...baseExamined, spread, manual_floor: MANUAL_FLOOR, auto_floor: AUTO_FLOOR },
      pending_writes: null,
    };
  }

  // 7. >=$20K spread + fresh inputs. If Auto_Approve_v2 is set, true auto;
  //    if not, fresh inputs but formula didn't auto-approve — still go to
  //    manual band since formula sees something we don't.
  if (!autoApprove) {
    return {
      recordId,
      bucket: "math_pass_manual",
      reasoning: `Spread $${spread} >= $${AUTO_FLOOR} auto-floor BUT Auto_Approve_v2=false. Formula sees a blocker (e.g. liquidity gate, distress, restricted state, etc.). Surface to Alex — don't auto-fire.`,
      data_examined: { ...baseExamined, spread, auto_floor: AUTO_FLOOR },
      pending_writes: null,
    };
  }

  return {
    recordId,
    bucket: "math_pass_auto",
    reasoning: `Spread $${spread} >= $${AUTO_FLOOR}, Auto_Approve_v2=true, ARV inputs fresh (${arvAge.toFixed(0)}hr). Math says auto-fire follow-up cadence.`,
    data_examined: { ...baseExamined, spread, auto_floor: AUTO_FLOOR },
    pending_writes: null,
  };
}

export interface MathSummary {
  total_examined: number;
  by_bucket: Record<MathBucket, number>;
  rentcast_budget_note: string;
}

export function summarizeMath(
  results: MathResult[],
  opts: { rentcastCallsAvailable: number },
): MathSummary {
  const by_bucket: Record<MathBucket, number> = {
    math_pass_auto: 0,
    math_pass_manual: 0,
    math_pass_needs_refresh: 0,
    math_fail_null_inputs: 0,
    math_fail_negative: 0,
    math_fail_below_threshold: 0,
    math_fail_list_drift: 0,
  };
  for (const r of results) by_bucket[r.bucket]++;

  // Pricing Agent calls RentCast twice per record (comps + rent).
  const reRunCandidates = by_bucket.math_pass_needs_refresh + by_bucket.math_fail_list_drift;
  const reRunsAffordable = Math.floor(opts.rentcastCallsAvailable / 2);
  const note =
    `Phase 0b.5 candidate pool: ${reRunCandidates} (needs_refresh + list_drift). ` +
    `RentCast budget: ${opts.rentcastCallsAvailable} calls available = ${reRunsAffordable} Pricing Agent re-runs affordable. ` +
    (reRunCandidates <= reRunsAffordable
      ? `All candidates fit budget.`
      : `Need to prioritize — ${reRunCandidates - reRunsAffordable} candidates exceed budget. Default priority: most recent texts first (Last_Outreach_Date DESC).`);

  return {
    total_examined: results.length,
    by_bucket,
    rentcast_budget_note: note,
  };
}
