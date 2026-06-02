// Pipeline_State backfill — shared runner.
// @agent: maverick / orchestrator
//
// Extracted so both apply surfaces share one implementation of the
// safety-critical pipeline (fetch → project → pre-filter → pool-execute
// via engine → audit → summarize):
//
//   - POST /api/admin/pipeline-state-backfill-apply   (dashboard cookie)
//   - POST /api/cron/pipeline-state-backfill-sweep    (CRON_SECRET, server-side)
//
// Both routes thin-wrap this. All six guardrails (decision
// rechGJ32oW9Qmv8wp) live here so they cannot be bypassed by adding a
// new caller — same verified mapping, blocklist hard-guard, idempotency,
// engine audit trail, batched + error-isolated, wall-clock-bounded.
//
// NOT a route. Pure logic + I/O via the engine deps. Safe to import
// from anywhere; the auth gating lives at the route layer.

import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  planBackfillRecord,
  type BackfillApplyCandidate,
  type BackfillPlan,
} from "./backfill-apply";
import { transitionStage } from "./engine";
import type { PipelineStage } from "./stages";
import { runAsyncPool } from "@/lib/crawler/async-pool";

// --- Runner-wide budget constants ------------------------------------
// 2026-06-01 reduction (post-incident): a max_records=4000 invocation on
// 2026-05-31 hit a Vercel 500 (error id 2YBolmqJ2OHX0MhrHJgqiDakbopi5dmz)
// when the function's wall time exceeded the lambda ceiling. ~3,358
// writes had landed by then (Airtable PATCH is server-side committed
// before the lambda returns) so the data is fine, but the operator
// surface saw a 500. Resolution: reduce HARD_MAX_RECORDS 2000 → 1000
// and WALL_CLOCK_BUDGET_MS 270_000 → 240_000 so the in-flight tail can
// settle inside the 300s lambda ceiling with margin.
export const RUNNER_DEFAULT_MAX_RECORDS = 500;
export const RUNNER_HARD_MAX_RECORDS = 1000;
export const RUNNER_DEFAULT_CONCURRENCY = 4;
export const RUNNER_HARD_MAX_CONCURRENCY = 10;
export const RUNNER_WALL_CLOCK_BUDGET_MS = 240_000;

export interface RunBackfillOpts {
  /** Per-invocation cap on records dispatched. Clamped to RUNNER_HARD_MAX_RECORDS. */
  max_records?: number;
  /** Concurrent in-flight engine calls. Clamped to RUNNER_HARD_MAX_CONCURRENCY. */
  concurrency?: number;
  /** Audit event tag — distinguishes the two callers (apply vs sweep). */
  audit_event: string;
  /** Audit attribution (agent name). */
  attribution: string;
  /** Triggered-by tag passed through to the engine. */
  triggered_by_label: string;
  /** Free-form context written to the run-level audit input summary. */
  audit_context?: Record<string, unknown>;
}

export interface BackfillResultRow {
  recordId: string;
  address: string | null;
  action: BackfillPlan["action"];
  reason: BackfillPlan["reason"];
  applied_stage: PipelineStage | null;
  derived_stage: PipelineStage | null;
  ok: boolean;
  outcome:
    | "applied"
    | "noop"
    | "skipped_already_populated"
    | "skipped_no_address"
    | "rejected_illegal"
    | "rejected_target"
    | "rejected_record"
    | "error";
  legality_reason?: string;
  error?: string;
  duration_ms: number;
}

export interface BackfillRunSummary {
  total_candidates: number;
  requested_max: number;
  processed: number;
  dispatched: number;
  skipped_undispatched: number;
  truncated_by_budget: boolean;
  by_outcome: Record<string, number>;
  by_action: Record<string, number>;
  by_reason: Record<string, number>;
  by_applied_stage: Record<string, number>;
  blacklist_overrides_applied: number;
  errors_count: number;
  illegal_rejections_count: number;
  max_in_flight: number;
  wall_clock_ms: number;
}

export interface BackfillRunResult {
  ok: boolean;
  summary: BackfillRunSummary;
  results: BackfillResultRow[];
  remaining_eligible_estimate: number;
  next_step: string;
  total_wall_ms: number;
}

/** Clamp `max_records` against the runner's hard cap; useful for routes
 *  that want to surface a 413-class error pre-execution. */
export function clampedMaxRecords(req?: number): number {
  if (typeof req !== "number" || !Number.isFinite(req) || req <= 0) {
    return RUNNER_DEFAULT_MAX_RECORDS;
  }
  return Math.min(RUNNER_HARD_MAX_RECORDS, Math.floor(req));
}

export function clampedConcurrency(req?: number): number {
  if (typeof req !== "number" || !Number.isFinite(req) || req <= 0) {
    return RUNNER_DEFAULT_CONCURRENCY;
  }
  return Math.min(RUNNER_HARD_MAX_CONCURRENCY, Math.floor(req));
}

/**
 * Run one bounded batch of the backfill. Sole source of write behavior
 * for both apply surfaces. Throws on listings-fetch failure; the caller
 * route maps that to its own 500. Per-record errors are isolated inside
 * the pool and end up in the summary, never propagated.
 */
export async function runBackfillBatch(
  opts: RunBackfillOpts,
): Promise<BackfillRunResult> {
  const t0 = Date.now();
  const maxRecords = clampedMaxRecords(opts.max_records);
  const concurrency = clampedConcurrency(opts.concurrency);

  // Fetch + pre-filter to records with empty pipelineStage.
  const allListings = await getListings();
  const candidates: BackfillApplyCandidate[] = allListings
    .filter((l) => !l.pipelineStage || l.pipelineStage.trim() === "")
    .map((l) => ({
      id: l.id,
      address: l.address ?? null,
      pipelineStage: l.pipelineStage ?? null,
      outreachStatus: l.outreachStatus ?? null,
      executionPath: l.executionPath ?? null,
      liveStatus: l.liveStatus ?? null,
      envelopeId: l.envelopeId ?? null,
      contractOfferPrice: l.contractOfferPrice ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const totalEligible = candidates.length;
  const batch = candidates.slice(0, maxRecords);

  const tStart = Date.now();
  const pool = await runAsyncPool<BackfillApplyCandidate, BackfillResultRow>({
    items: batch,
    concurrency,
    shouldStopDispatch: () => Date.now() - tStart > RUNNER_WALL_CLOCK_BUDGET_MS,
    worker: async (c) => {
      const tr0 = Date.now();
      const plan = planBackfillRecord(c);

      if (plan.action === "skip_already_populated") {
        return {
          recordId: plan.recordId,
          address: plan.address,
          action: plan.action,
          reason: plan.reason,
          applied_stage: null,
          derived_stage: plan.derived_stage,
          ok: true,
          outcome: "skipped_already_populated",
          duration_ms: Date.now() - tr0,
        };
      }
      if (plan.action === "skip_no_address") {
        return {
          recordId: plan.recordId,
          address: plan.address,
          action: plan.action,
          reason: plan.reason,
          applied_stage: null,
          derived_stage: plan.derived_stage,
          ok: true,
          outcome: "skipped_no_address",
          duration_ms: Date.now() - tr0,
        };
      }

      // Apply via the engine (sole writer). Pre-supply `current: null` so
      // the engine skips the getCurrentStage fetch — we already pre-
      // filtered on pipelineStage empty. Engine returns
      // `ok_initial_assignment` for null→derived.
      const target = plan.apply_stage!;
      try {
        const txn = await transitionStage({
          recordId: plan.recordId,
          to: target,
          reason: `backfill:${plan.reason}`,
          attribution: opts.attribution,
          triggered_by: "backfill",
          current: { pipelineStage: null },
        });
        return {
          recordId: plan.recordId,
          address: plan.address,
          action: plan.action,
          reason: plan.reason,
          applied_stage: txn.ok && txn.outcome === "applied" ? target : null,
          derived_stage: plan.derived_stage,
          ok: txn.ok,
          outcome: txn.outcome as BackfillResultRow["outcome"],
          legality_reason: txn.legality.reason,
          duration_ms: Date.now() - tr0,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          recordId: plan.recordId,
          address: plan.address,
          action: plan.action,
          reason: plan.reason,
          applied_stage: null,
          derived_stage: plan.derived_stage,
          ok: false,
          outcome: "error",
          error: msg,
          duration_ms: Date.now() - tr0,
        };
      }
    },
  });

  const results = pool.results.map((r) => r.value);
  const summary: BackfillRunSummary = {
    total_candidates: totalEligible,
    requested_max: maxRecords,
    processed: results.length,
    dispatched: results.length,
    skipped_undispatched: pool.skipped.length,
    truncated_by_budget: pool.skipped.length > 0,
    by_outcome: tally(results, (r) => r.outcome),
    by_action: tally(results, (r) => r.action),
    by_reason: tally(results, (r) => r.reason),
    by_applied_stage: tally(
      results.filter((r) => r.applied_stage != null),
      (r) => r.applied_stage as string,
    ),
    blacklist_overrides_applied: results.filter(
      (r) =>
        r.action === "apply_blacklist_dead" &&
        r.ok &&
        r.outcome === "applied",
    ).length,
    errors_count: results.filter((r) => !r.ok || r.outcome === "error").length,
    illegal_rejections_count: results.filter(
      (r) => r.outcome === "rejected_illegal",
    ).length,
    max_in_flight: pool.maxInFlight,
    wall_clock_ms: Date.now() - tStart,
  };

  const remainingEligible = Math.max(
    0,
    totalEligible -
      results.filter(
        (r) =>
          r.outcome === "applied" ||
          r.outcome === "skipped_already_populated",
      ).length,
  );

  await audit({
    agent: opts.attribution,
    event: opts.audit_event,
    status: summary.errors_count > 0 ? "uncertain" : "confirmed_success",
    inputSummary: {
      max_records: maxRecords,
      concurrency,
      ...(opts.audit_context ?? {}),
    },
    outputSummary: {
      total_candidates: summary.total_candidates,
      processed: summary.processed,
      by_outcome: summary.by_outcome,
      blacklist_overrides_applied: summary.blacklist_overrides_applied,
      errors_count: summary.errors_count,
      illegal_rejections_count: summary.illegal_rejections_count,
      truncated_by_budget: summary.truncated_by_budget,
      remaining_eligible_estimate: remainingEligible,
      wall_clock_ms: summary.wall_clock_ms,
    },
    decision: "applied",
    ms: Date.now() - t0,
  });

  return {
    ok: true,
    summary,
    results,
    remaining_eligible_estimate: remainingEligible,
    next_step:
      remainingEligible > 0
        ? `Run again with the same body to continue — ${remainingEligible} records still eligible (re-run is idempotent via the empty-pipelineStage pre-filter + the engine's noop short-circuit).`
        : "Backfill complete — no eligible records remain (zero records with empty Pipeline_Stage).",
    total_wall_ms: Date.now() - t0,
  };
}

function tally<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
