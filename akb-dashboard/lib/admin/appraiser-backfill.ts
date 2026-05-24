// Phase 16.x / M — Appraiser backfill helpers.
//
// Pure helpers shared between dry-run (M.1) and apply (M.2) modes of
// /api/admin/appraiser-backfill. Lives here so the route stays thin
// and the eligibility / cost logic can be unit-tested without React.
//
// Eligibility gate:
//   - Active outreach status only (the brief's "active deals only" —
//     getActiveListingsForBrief already filters Dead/Walked/etc).
//   - LOW-ARV-confidence records are treated as Manual Review and
//     SKIPPED unless include_manual_review=1. Phase 4A.1 spec routes
//     LOW (<3 comps) to manual review precisely to avoid auto-running
//     expensive Appraiser endpoints on records the math can't trust.
//   - Idempotency completes a record when ARV_Validated_At +
//     Rehab_Estimated_At + Estimated_Monthly_Rent are all populated.
//     `force=true` overrides.
//
// Cost estimation is expressed in API-call counts (not dollars) so
// the operator can apply current pricing. Per record at most:
//   - ARV: 1 ScraperAPI call (comp pull). Counts even if cached
//     comps would short-circuit — conservative upper bound.
//   - Rehab: 1 Anthropic vision call (photo analysis). Skipped if
//     rehabEstimatedAt is already populated (idempotent endpoint
//     no-ops on its side, but counted here only when fresh).
//   - Buyer Intelligence: 1 RentCast call IFF estimatedMonthlyRent
//     is null (the endpoint caches rent across runs unless force_rent=1).

import type { Listing } from "@/lib/types";

export interface BackfillEligibilityOpts {
  /** When true, includes records with arvConfidence === "LOW" (Phase
   *  4A.1's Manual Review route). Default false — manual review
   *  records are operator-call territory, not automated. */
  includeManualReview?: boolean;
  /** When true, ignores the "all three timestamps populated" skip
   *  gate. Use for re-runs after rehab/ARV inputs have changed. */
  force?: boolean;
}

export type BackfillSkipReason =
  | "manual_review_low_arv"
  | "already_complete"
  | "missing_zip"
  | null;

export interface BackfillEligibility {
  recordId: string;
  eligible: boolean;
  skipReason: BackfillSkipReason;
  /** Snapshot of which of the three completion timestamps were
   *  already populated. Surfaces what the backfill DIDN'T touch. */
  current: {
    arv_validated_at: string | null;
    rehab_estimated_at: string | null;
    estimated_monthly_rent: number | null;
    arv_confidence: "HIGH" | "MED" | "LOW" | null;
  };
}

/** Pure: classify a listing against the backfill eligibility rules. */
export function classifyBackfillEligibility(
  listing: Pick<
    Listing,
    | "id"
    | "zip"
    | "arvValidatedAt"
    | "rehabEstimatedAt"
    | "estimatedMonthlyRent"
    | "arvConfidence"
    | "realArvMedian"
  >,
  opts: BackfillEligibilityOpts = {},
): BackfillEligibility {
  const current = {
    arv_validated_at: listing.arvValidatedAt ?? null,
    rehab_estimated_at: listing.rehabEstimatedAt ?? null,
    estimated_monthly_rent: listing.estimatedMonthlyRent ?? null,
    arv_confidence: listing.arvConfidence ?? null,
  };

  // ARV endpoint needs zip to look up comps. Skip records without one.
  if (!listing.zip || listing.zip.trim().length === 0) {
    return { recordId: listing.id, eligible: false, skipReason: "missing_zip", current };
  }

  // Manual Review gate: Phase 4A.1 routes LOW (<3 comps) to operator
  // review. ARV value is present but confidence too low to trust —
  // re-running won't fix the underlying comp shortage.
  if (current.arv_confidence === "LOW" && !opts.includeManualReview) {
    return { recordId: listing.id, eligible: false, skipReason: "manual_review_low_arv", current };
  }

  // Idempotency: skip when all three completion timestamps populated.
  // Note: rent uses the value (not a timestamp) since the schema
  // doesn't have a rent_validated_at field.
  const complete =
    current.arv_validated_at != null &&
    current.rehab_estimated_at != null &&
    current.estimated_monthly_rent != null;
  if (complete && !opts.force) {
    return { recordId: listing.id, eligible: false, skipReason: "already_complete", current };
  }

  return { recordId: listing.id, eligible: true, skipReason: null, current };
}

export interface BackfillCostEstimate {
  /** ARV endpoint fires regardless — comps re-pull on every run. */
  scraperapi_calls: number;
  /** Rehab endpoint fires regardless — photo vision re-runs. The
   *  Appraiser endpoint dedupes on its own ID side, but worst-case
   *  here counts a call. */
  anthropic_calls: number;
  /** RentCast fires ONLY when estimatedMonthlyRent is null (the
   *  Buyer Intelligence endpoint caches across runs unless
   *  force_rent=1, which the backfill never sets). */
  rentcast_calls: number;
}

/** Pure: per-record cost estimate as API-call counts. */
export function estimateBackfillCost(
  listing: Pick<Listing, "estimatedMonthlyRent">,
): BackfillCostEstimate {
  const rentNeeded =
    listing.estimatedMonthlyRent == null || listing.estimatedMonthlyRent <= 0;
  return {
    scraperapi_calls: 1,
    anthropic_calls: 1,
    rentcast_calls: rentNeeded ? 1 : 0,
  };
}

/** Pure: sum cost estimates across eligible records. */
export function totalBackfillCost(
  estimates: BackfillCostEstimate[],
): BackfillCostEstimate {
  return estimates.reduce<BackfillCostEstimate>(
    (acc, e) => ({
      scraperapi_calls: acc.scraperapi_calls + e.scraperapi_calls,
      anthropic_calls: acc.anthropic_calls + e.anthropic_calls,
      rentcast_calls: acc.rentcast_calls + e.rentcast_calls,
    }),
    { scraperapi_calls: 0, anthropic_calls: 0, rentcast_calls: 0 },
  );
}

// ── M.2 — pacing + per-endpoint outcome tracking ────────────────────────

/** Default conservative pace between records (ms). Overridable via
 *  BACKFILL_PACE_MS env var per Alex's brief. */
const DEFAULT_PACE_MS = 2000;
/** Pace clamps: zero allows back-to-back firing (rarely safe; only for
 *  isolated reruns). Hard upper bound keeps a lambda from waiting
 *  forever inside the loop. */
const MIN_PACE_MS = 0;
const MAX_PACE_MS = 30_000;

/** Pure: read pacing (ms between records) from env with defaults +
 *  clamping. Invalid values fall through to default. */
export function readBackfillPaceMs(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const raw = env.BACKFILL_PACE_MS;
  if (!raw) return DEFAULT_PACE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_PACE_MS) return DEFAULT_PACE_MS;
  return Math.min(n, MAX_PACE_MS);
}

export type BackfillEndpointStatus = "ok" | "error";

export interface BackfillEndpointOutcome {
  status: BackfillEndpointStatus;
  http_status: number | null;
  elapsed_ms: number;
  error: string | null;
}

export interface BackfillRecordApplyOutcome {
  recordId: string;
  /** Aggregate: "ok" only when all three endpoints succeeded; "partial"
   *  when at least one failed but at least one succeeded; "error" when
   *  all three failed. */
  status: "ok" | "partial" | "error";
  arv: BackfillEndpointOutcome;
  rehab: BackfillEndpointOutcome;
  buyer_intelligence: BackfillEndpointOutcome;
  total_elapsed_ms: number;
}

/** Pure: roll the three per-endpoint statuses up into the record-level
 *  aggregate. Used by the route to compute outcome.status. */
export function aggregateBackfillStatus(
  arv: BackfillEndpointStatus,
  rehab: BackfillEndpointStatus,
  buyerIntel: BackfillEndpointStatus,
): "ok" | "partial" | "error" {
  const okCount =
    (arv === "ok" ? 1 : 0) +
    (rehab === "ok" ? 1 : 0) +
    (buyerIntel === "ok" ? 1 : 0);
  if (okCount === 3) return "ok";
  if (okCount === 0) return "error";
  return "partial";
}
