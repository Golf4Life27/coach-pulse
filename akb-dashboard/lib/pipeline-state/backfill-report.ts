// Pipeline_State — pure dry-run backfill report aggregator.
// @agent: maverick
//
// Per spec §7 step 4 (LOCKED 2026-05-31): mass backfill is a SEPARATE,
// operator-reviewed, dry-run-first step. This module ships the pure
// aggregator that computes the report; the route at
// `/api/admin/pipeline-state-backfill-dryrun` is a thin GET wrapper on
// top. NEITHER writes Airtable — reading the report is operator step 1
// of the eventual apply flow.
//
// Pure. No I/O.

import {
  deriveStageFromLegacy,
  type DerivableListing,
  type DerivationConfidence,
  type DerivationResult,
} from "./derive";
import type { PipelineStage } from "./stages";
import { ALL_PIPELINE_STAGES } from "./stages";

/**
 * What the dry-run endpoint needs to fingerprint a record for the
 * operator (the address is the only human-readable handle). All other
 * derivation inputs come from DerivableListing.
 */
export interface BackfillReportListing extends DerivableListing {
  id: string;
  address?: string | null;
}

export interface BackfillProposal {
  recordId: string;
  address: string | null;
  /** Currently-populated Pipeline_Stage value (null when empty). */
  current: PipelineStage | null;
  /** Proposed stage the derivation produced. */
  proposed: PipelineStage;
  /** Will the apply step change anything? `false` when the field is already
   *  populated and the derivation short-circuits. */
  changes: boolean;
  confidence: DerivationConfidence;
  reason: DerivationResult["reason"];
  message: string;
  /** Each conflicting signal worth surfacing — empty array on clean records. */
  conflicts: string[];
}

export interface BackfillReport {
  /** ISO timestamp at which the report ran. */
  computed_at: string;
  /** Total records considered. */
  total_records: number;
  /** Records whose `pipelineStage` is already populated — derivation
   *  short-circuits, NO change proposed. */
  records_already_populated: number;
  /** Records the derivation proposes a stage for (current !== proposed
   *  OR current is null). */
  records_with_proposed_change: number;
  /** Records where derivation surfaced ≥1 conflict (23-Fields-class). */
  records_with_conflicts: number;
  /** Histogram of PROPOSED stage values across records (incl. already-populated). */
  histogram_proposed: Record<PipelineStage, number>;
  /** Histogram of derivation reason codes (which rule matched). */
  histogram_reason: Record<string, number>;
  /** Counts of high / medium / low confidence verdicts. */
  confidence_breakdown: Record<DerivationConfidence, number>;
  /** First N proposed transitions for operator inspection (changes only). */
  proposed_transitions_sample: BackfillProposal[];
  /** First N records with conflicts surfaced for operator review. */
  conflicts_sample: BackfillProposal[];
}

export interface BackfillReportOpts {
  /** Cap each sample array. Defaults to 50 so the response stays small. */
  sampleLimit?: number;
  /** ISO override (tests only). */
  now?: () => Date;
}

/**
 * Pure: compute the dry-run report for a snapshot of listings.
 *
 * NEVER writes — caller (the route) is read-only by construction.
 *
 * Aggregation rules:
 *   - Every record runs through `deriveStageFromLegacy`.
 *   - `records_already_populated` counts the short-circuit branch
 *     (current Pipeline_Stage is non-empty) — these contribute to the
 *     histograms but NOT to `proposed_transitions_sample`.
 *   - `records_with_proposed_change` counts records where the apply
 *     step would write a new value (current !== proposed OR current is
 *     null).
 *   - Conflicts (e.g. the 23-Fields-class `Negotiating` + `Reject`) are
 *     surfaced even when the derivation produced a stage — they're a
 *     review signal, not a stop signal.
 */
export function buildBackfillReport(
  listings: BackfillReportListing[],
  opts: BackfillReportOpts = {},
): BackfillReport {
  const sampleLimit = opts.sampleLimit ?? 50;
  const now = opts.now ?? (() => new Date());

  const histogram_proposed = Object.fromEntries(
    ALL_PIPELINE_STAGES.map((s) => [s, 0]),
  ) as Record<PipelineStage, number>;
  const histogram_reason: Record<string, number> = {};
  const confidence_breakdown: Record<DerivationConfidence, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };

  const proposedSample: BackfillProposal[] = [];
  const conflictsSample: BackfillProposal[] = [];

  let records_already_populated = 0;
  let records_with_proposed_change = 0;
  let records_with_conflicts = 0;

  for (const l of listings) {
    const result = deriveStageFromLegacy(l);
    histogram_proposed[result.stage] = (histogram_proposed[result.stage] ?? 0) + 1;
    histogram_reason[result.reason] = (histogram_reason[result.reason] ?? 0) + 1;
    confidence_breakdown[result.confidence]++;

    const isPopulated = result.reason === "pipeline_stage_already_set";
    const current = isPopulated ? (l.pipelineStage as PipelineStage) : null;
    const changes = !isPopulated; // derive only short-circuits when populated

    if (isPopulated) {
      records_already_populated++;
    } else {
      records_with_proposed_change++;
    }

    const proposal: BackfillProposal = {
      recordId: l.id,
      address: l.address ?? null,
      current,
      proposed: result.stage,
      changes,
      confidence: result.confidence,
      reason: result.reason,
      message: result.message,
      conflicts: result.conflicts,
    };

    if (result.conflicts.length > 0) {
      records_with_conflicts++;
      if (conflictsSample.length < sampleLimit) {
        conflictsSample.push(proposal);
      }
    }

    if (changes && proposedSample.length < sampleLimit) {
      proposedSample.push(proposal);
    }
  }

  return {
    computed_at: now().toISOString(),
    total_records: listings.length,
    records_already_populated,
    records_with_proposed_change,
    records_with_conflicts,
    histogram_proposed,
    histogram_reason,
    confidence_breakdown,
    proposed_transitions_sample: proposedSample,
    conflicts_sample: conflictsSample,
  };
}
