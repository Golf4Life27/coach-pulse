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
/** Consolidation Night 2026-07-29 (item E): terminal no-photo-source flag.
 *  A rehab 422 of no_photos_available / street_view_only_insufficient is an
 *  ANSWER ("this property has no usable photo source"), not a transient
 *  failure — the same lesson as the honest-404 pattern. Before this flag,
 *  the answer was counted as an error: 5 failure rounds → 7-day bench →
 *  TTL lapse → 5 MORE paid rounds, forever, each round re-buying the
 *  RentCast photo pulls inside collectPhotos. 30-day TTL = a slow re-test
 *  (a re-listed property can gain photos), mirroring the pause-not-death
 *  doctrine rather than a permanent door. */
export const rehabUnproducibleKey = (recordId: string) => `p2:rehab:no_photo_source:${recordId}`;
export const REHAB_UNPRODUCIBLE_TTL_S = 30 * 86_400;
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
  | "skip_failure_capped"
  // Terminal answer: no usable photo source exists for this record (422
  // no_photos_available / street_view_only_insufficient). Re-tested only
  // after the 30d flag lapses.
  | "skip_unproducible"
  // The CALLER narrowed which legs run this pass (?legs=arv comp-coverage
  // sweep, 2026-08-15) — the leg is still due and will run on a later pass.
  // Distinct from every skip_* above so the audit never reads a deferred leg
  // as a completed or terminally-dead one.
  | "skip_leg_filtered";

export interface RecordLegPlan {
  arv: LegPlan;
  rehab: LegPlan;
  rent: LegPlan;
}

export interface PlanLegsInput {
  arvValidatedAt: string | null;
  /** Has this record's ARV_Comp_Details_JSON ever been WRITTEN — real comps
   *  OR the honest-empty exclusion receipts?
   *
   *  WHY (2026-08-15, the no-op sweep). The gate treated a trusted
   *  ARV_Validated_At stamp as proof the ARV leg was done. That was true when
   *  the leg's only output was a NUMBER. Since the own-comps ARV basis
   *  (97d6968) the leg's load-bearing output is the COMP ARRAY, and a record
   *  can carry a recent stamp with an empty comps field — priced under the
   *  old regime, or stamped before the appraiser wrote receipts. The first
   *  comp-coverage sweep hit exactly that: 16 slices, 4 records, every ARV
   *  leg "skip_done", zero comps written, and a driver that logged
   *  "64 records backfilled". A stamp is a claim; the comps are the evidence.
   *
   *  TERMINATOR — why this cannot loop: an honest-empty compute still WRITES
   *  the field (arv-write.ts persists comps_excluded when comps_used is
   *  empty), so one run flips this true whether or not usable comps exist.
   *  Deliberately keyed on WRITTEN, never on USABLE: keying on usable would
   *  re-buy comps forever for every property that genuinely has none. */
  arvCompEvidencePresent: boolean;
  rehabEstimatedAt: string | null;
  estimatedMonthlyRent: number | null;
  force: boolean;
  /** Is the KV ledger reachable this run? Without it the rehab leg treats
   *  any completed read as done (no confirmation read — never spend on an
   *  unmetered loop). */
  kvAvailable: boolean;
  /** KV stable flag for the rehab leg (two agreeing reads recorded). */
  rehabStable: boolean;
  /** KV no-photo-source flag: a prior run got the terminal "no usable
   *  photos" answer. Rehab leg skips until the 30d flag lapses. */
  rehabUnproducible?: boolean;
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
  // DONE requires BOTH a trusted stamp AND the comp evidence on the record.
  // Either alone is insufficient: a stamp without comps is a number whose
  // basis no longer exists, and comps without a trusted stamp are pre-epoch
  // output. The failure cap still outranks a re-run so a genuinely broken
  // record benches instead of looping.
  const arv: LegPlan =
    arvStampTrusted(input.arvValidatedAt) && input.arvCompEvidencePresent
      ? "skip_done"
      : input.failures.arv >= cap
        ? "skip_failure_capped"
        : "run";

  let rehab: LegPlan;
  if (input.rehabUnproducible) {
    // The terminal answer outranks everything except force: firing again
    // re-buys photo pulls for a property with no photo source.
    rehab = "skip_unproducible";
  } else if (input.rehabStable) {
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
