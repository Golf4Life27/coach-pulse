// P2 done-gate (#35, operator triage brief 2026-07-06, spine
// recKl6eGxsJZPmwCw + reclLRGpgOgdKAKZX).
//
// THE BUG: the appraiser-backfill cron (*/5 min, selection=rehab_ready,
// limit=3) fired ALL THREE legs (ARV / rehab-vision / rent) on every
// eligible record on every pass — and a record stays "eligible" until all
// three completion markers are populated. One permanently-missing leg
// (rent that RentCast can't produce, ARV that never stamps) therefore
// bought an Anthropic vision read every cycle FOREVER: reccyLTGRZzMmbe2w
// showed 5 identical reads (conf 42, rehab_mid $51,183). A job that
// re-runs without a done-gate is a bug, not a retry policy.
//
// THE GATE, per the operator-approved definition ("stable" = consecutive
// reads agreeing: confidence equal + rehab_mid within ±$5):
//   - Per-leg idempotency: a leg whose completion marker is populated is
//     DONE and never re-fires (force=1 overrides).
//   - Rehab confirmation read: with the KV ledger available, a record
//     with one read gets exactly ONE more; when the two agree the record
//     is marked STABLE in KV and the vision leg never fires again. When
//     KV is unavailable, a leg with any completed read is treated as done
//     — fail toward NOT spending.
//   - Failure cap: a leg that errors N consecutive times (default 5) is
//     benched (KV, 7d TTL) instead of looping every 5 minutes.
//   - Burn quantification: every skip is counted as calls avoided, by
//     vendor, in the response + audit.
//
// PURE. The route supplies KV state and does the I/O.

import { arvStampTrusted } from "@/lib/arv-epoch";

export const DEFAULT_STABLE_REHAB_DELTA_USD = 5;
export const DEFAULT_LEG_FAILURE_CAP = 5;
export const STABLE_FLAG_TTL_S = 30 * 86_400;
export const FAILURE_COUNT_TTL_S = 7 * 86_400;

export const rehabStableKey = (recordId: string) => `p2:rehab:stable:${recordId}`;
export const legFailureKey = (recordId: string, leg: LegName) => `p2:fail:${leg}:${recordId}`;

export type LegName = "arv" | "rehab" | "rent";

export interface RehabRead {
  conf: number | null;
  mid: number | null;
}

/** Pure: do two consecutive rehab reads agree? Both mids must exist and
 *  sit within ±maxDeltaUsd; confidences must be equal (null == null). */
export function readsAgree(
  prev: RehabRead,
  next: RehabRead,
  maxDeltaUsd: number = DEFAULT_STABLE_REHAB_DELTA_USD,
): boolean {
  if (prev.mid == null || next.mid == null) return false;
  if (Math.abs(prev.mid - next.mid) > maxDeltaUsd) return false;
  return (prev.conf ?? null) === (next.conf ?? null);
}

export type LegPlan =
  | "run"
  | "skip_done"
  | "skip_stable"
  | "skip_failure_capped";

export interface RecordLegPlan {
  arv: LegPlan;
  rehab: LegPlan;
  rent: LegPlan;
}

export interface PlanLegsInput {
  arvValidatedAt: string | null;
  rehabEstimatedAt: string | null;
  estimatedMonthlyRent: number | null;
  force: boolean;
  /** Is the KV ledger reachable this run? Without it the rehab leg treats
   *  any completed read as done (no confirmation read — never spend on an
   *  unmetered loop). */
  kvAvailable: boolean;
  /** KV stable flag for the rehab leg (two agreeing reads recorded). */
  rehabStable: boolean;
  /** Consecutive-failure counts per leg (0 when absent). */
  failures: { arv: number; rehab: number; rent: number };
  failureCap?: number;
}

/** Pure: which legs does THIS record still owe? */
export function planLegs(input: PlanLegsInput): RecordLegPlan {
  const cap = input.failureCap ?? DEFAULT_LEG_FAILURE_CAP;
  if (input.force) return { arv: "run", rehab: "run", rent: "run" };

  // Epoch gate (#126 remediation): only a stamp from the sold-comps-only
  // engine counts as done. A pre-epoch stamp is contaminated output — the
  // leg re-runs so the fixed engine replaces the fiction. Loop safety: the
  // fixed ARV route stamps on EVERY successful compute, including zero-comp
  // results (which land as LOW → the manual_review_low_arv eligibility gate
  // takes the record out of the sweep), so a re-run always terminates.
  const arv: LegPlan =
    arvStampTrusted(input.arvValidatedAt)
      ? "skip_done"
      : input.failures.arv >= cap
        ? "skip_failure_capped"
        : "run";

  let rehab: LegPlan;
  if (input.rehabStable) {
    rehab = "skip_stable";
  } else if (input.rehabEstimatedAt != null && !input.kvAvailable) {
    // A read exists but there is no ledger to record a confirmation —
    // fail toward not spending.
    rehab = "skip_done";
  } else if (input.failures.rehab >= cap) {
    rehab = "skip_failure_capped";
  } else {
    // First read, or the single confirmation read (ledger available).
    rehab = "run";
  }

  const rent: LegPlan =
    input.estimatedMonthlyRent != null && input.estimatedMonthlyRent > 0
      ? "skip_done"
      : input.failures.rent >= cap
        ? "skip_failure_capped"
        : "run";

  return { arv, rehab, rent };
}

/** Pure: calls avoided by the skips in a plan — the burn quantification.
 *  Vendor mapping mirrors estimateBackfillCost: arv=ScraperAPI,
 *  rehab=Anthropic vision, rent=RentCast. */
export function callsAvoided(plans: RecordLegPlan[]): {
  scraperapi: number;
  anthropic: number;
  rentcast: number;
} {
  let scraperapi = 0;
  let anthropic = 0;
  let rentcast = 0;
  for (const p of plans) {
    if (p.arv !== "run") scraperapi++;
    if (p.rehab !== "run") anthropic++;
    if (p.rent !== "run") rentcast++;
  }
  return { scraperapi, anthropic, rentcast };
}

/** Pure: tunables from env. */
export function readP2Config(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): { stableDeltaUsd: number; failureCap: number } {
  const d = Number(env.P2_STABLE_REHAB_DELTA_USD);
  const c = Number(env.P2_LEG_FAILURE_CAP);
  return {
    stableDeltaUsd: Number.isFinite(d) && d >= 0 ? d : DEFAULT_STABLE_REHAB_DELTA_USD,
    failureCap: Number.isFinite(c) && c > 0 ? Math.floor(c) : DEFAULT_LEG_FAILURE_CAP,
  };
}
