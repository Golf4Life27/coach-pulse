// Pipeline_State backfill — GATED APPLY route.
// @agent: maverick / orchestrator
//
// POST /api/admin/pipeline-state-backfill-apply
//   body: {
//     confirm: "BACKFILL-PIPELINE-STATE-YYYY-MM-DD",  // today's UTC date
//     max_records?: number,                            // default 500, max 2000
//     concurrency?: number                             // default 4,   max 10
//   }
//
// The non-negotiable guardrails the operator locked in decision
// rechGJ32oW9Qmv8wp (builds on verified dry-run rec7cYhtOBMWRN1PZ):
//
//   1. Same verified `deriveStageFromLegacy` mapping — no new mapping
//      logic; lives in `lib/pipeline-state/derive.ts`.
//   2. Gated to the authenticated dashboard cookie path ONLY. OAuth,
//      CRON_SECRET, and dev-bearer paths are explicitly REFUSED here —
//      a mass write must be operator-driven from an authenticated UI,
//      not by a stale token or cron.
//   3. Canon §9 blocklist HARD-GUARD via `isNeverResurfaceLoose` in
//      `planBackfillRecord` — enforced in code, not data.
//   4. Idempotent: pre-filter to records with empty `pipelineStage`;
//      engine itself short-circuits noop as a second line of defense.
//      Re-running is safe; the route is resumable by re-invocation.
//   5. Every write routes through `transitionStage` — null → derived is
//      `ok_initial_assignment` (a SEED, not a failing skip-forward).
//   6. Batched with bounded concurrency (default 4 in flight); each
//      record's outcome captured into a per-record result for the
//      summary response. Errors are isolated — one failure doesn't
//      poison the run.
//
// Mass-fire stays gated for a separate operator go: the route accepts a
// `max_records` cap (default 500) and audits every invocation. The
// operator runs it until `remaining_eligible_estimate === 0`.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  hasDashboardSession,
} from "@/lib/maverick/oauth/auth-waterfall";
import {
  planBackfillRecord,
  confirmTokenMatches,
  expectedConfirmToken,
  type BackfillApplyCandidate,
  type BackfillPlan,
} from "@/lib/pipeline-state/backfill-apply";
import { transitionStage } from "@/lib/pipeline-state/engine";
import type { PipelineStage } from "@/lib/pipeline-state/stages";
import { runAsyncPool } from "@/lib/crawler/async-pool";

export const runtime = "nodejs";
// Pro plan ceiling. With concurrency=4 and ~150ms per transitionStage
// call (Airtable PATCH + audit), we can comfortably process ~500 records
// in ~20s of wall time, leaving margin for tail latency.
export const maxDuration = 300;

const DEFAULT_MAX_RECORDS = 500;
const HARD_MAX_RECORDS = 2000;
const DEFAULT_CONCURRENCY = 4;
const HARD_MAX_CONCURRENCY = 10;
// Wall-clock budget. 270s leaves headroom under the 300s lambda ceiling.
const WALL_CLOCK_BUDGET_MS = 270_000;

interface ApplyResultRow {
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

export async function POST(req: Request) {
  const t0 = Date.now();

  // ── Gate 1: dashboard cookie ONLY ─────────────────────────────────
  // Spec'd as "no exposed secrets" — refuse OAuth / CRON_SECRET /
  // dev-bearer here even though the standard waterfall would accept
  // them. Mass writes must be operator-driven from the authenticated UI.
  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    return NextResponse.json(
      {
        error: "unauthorized",
        reason: "dashboard_session_required",
        message:
          "This route is gated to the authenticated dashboard session ONLY (akb-auth cookie). OAuth / CRON_SECRET / dev-bearer are intentionally refused for mass-write safety.",
      },
      { status: 401 },
    );
  }

  // ── Parse body ─────────────────────────────────────────────────────
  let body: { confirm?: unknown; max_records?: unknown; concurrency?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      {
        error: "invalid_json",
        message: "POST body must be valid JSON.",
      },
      { status: 400 },
    );
  }

  // ── Gate 2: confirm token ─────────────────────────────────────────
  const supplied =
    typeof body.confirm === "string" ? (body.confirm as string) : null;
  const now = new Date();
  if (!confirmTokenMatches(supplied, now)) {
    return NextResponse.json(
      {
        error: "confirm_required",
        message: `Body must include \`confirm\` matching today's UTC token. Required value:`,
        expected_token: expectedConfirmToken(now),
        hint: "Operator must type today's date explicitly — replay protection + intentional gesture.",
      },
      { status: 400 },
    );
  }

  // ── Param clamps ──────────────────────────────────────────────────
  const maxRecords =
    typeof body.max_records === "number" && body.max_records > 0
      ? Math.min(HARD_MAX_RECORDS, Math.floor(body.max_records))
      : DEFAULT_MAX_RECORDS;
  const concurrency =
    typeof body.concurrency === "number" && body.concurrency > 0
      ? Math.min(HARD_MAX_CONCURRENCY, Math.floor(body.concurrency))
      : DEFAULT_CONCURRENCY;

  // ── Load listings + project to apply-planner candidates ───────────
  let allListings;
  try {
    allListings = await getListings();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "maverick",
      event: "pipeline_state_backfill_apply",
      status: "confirmed_failure",
      inputSummary: { max_records: maxRecords, concurrency },
      outputSummary: { stage: "load_listings", duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { ok: false, error: "load_listings_failed", message: msg },
      { status: 500 },
    );
  }

  // Project to the apply-planner candidate shape + filter to records
  // that need attention (pipelineStage empty). Sort by recordId for
  // deterministic batch order across invocations — re-running picks up
  // where the prior run left off naturally because the filled records
  // drop out of the eligible set.
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

  // ── Apply ─────────────────────────────────────────────────────────
  const tStart = Date.now();
  const pool = await runAsyncPool<BackfillApplyCandidate, ApplyResultRow>({
    items: batch,
    concurrency,
    shouldStopDispatch: () => Date.now() - tStart > WALL_CLOCK_BUDGET_MS,
    worker: async (c) => {
      const tr0 = Date.now();
      const plan = planBackfillRecord(c);

      // Skips never call the engine.
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
      // filtered on pipelineStage empty. The legal-edge check returns
      // `ok_initial_assignment` (seed), not a failing skip-forward.
      const target = plan.apply_stage!;
      try {
        const txn = await transitionStage(
          {
            recordId: plan.recordId,
            to: target,
            reason: `backfill:${plan.reason}`,
            attribution: "maverick",
            triggered_by: "backfill",
            current: { pipelineStage: null },
          },
        );
        return {
          recordId: plan.recordId,
          address: plan.address,
          action: plan.action,
          reason: plan.reason,
          applied_stage: txn.ok && txn.outcome === "applied" ? target : null,
          derived_stage: plan.derived_stage,
          ok: txn.ok,
          outcome: txn.outcome as ApplyResultRow["outcome"],
          legality_reason: txn.legality.reason,
          duration_ms: Date.now() - tr0,
        };
      } catch (err) {
        // Engine's updateListingRecord can throw on Airtable 4xx/5xx —
        // isolate it so one bad record doesn't poison the batch.
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

  // ── Summarize ──────────────────────────────────────────────────────
  const results = pool.results.map((r) => r.value);
  const summary = {
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
      (r) => r.action === "apply_blacklist_dead" && r.ok && r.outcome === "applied",
    ).length,
    errors_count: results.filter((r) => !r.ok || r.outcome === "error").length,
    illegal_rejections_count: results.filter((r) => r.outcome === "rejected_illegal").length,
    max_in_flight: pool.maxInFlight,
    wall_clock_ms: Date.now() - tStart,
  };

  // Final run-level audit.
  await audit({
    agent: "maverick",
    event: "pipeline_state_backfill_apply",
    status: summary.errors_count > 0 ? "uncertain" : "confirmed_success",
    inputSummary: {
      max_records: maxRecords,
      concurrency,
      confirm_token_date: expectedConfirmToken(now),
    },
    outputSummary: {
      total_candidates: summary.total_candidates,
      processed: summary.processed,
      by_outcome: summary.by_outcome,
      blacklist_overrides_applied: summary.blacklist_overrides_applied,
      errors_count: summary.errors_count,
      illegal_rejections_count: summary.illegal_rejections_count,
      wall_clock_ms: summary.wall_clock_ms,
    },
    decision: "applied",
    ms: Date.now() - t0,
  });

  const remainingEligible = Math.max(
    0,
    totalEligible -
      results.filter(
        (r) =>
          r.outcome === "applied" || r.outcome === "skipped_already_populated",
      ).length,
  );

  return NextResponse.json({
    ok: true,
    summary,
    next_step:
      remainingEligible > 0
        ? `Run again with the same body to continue — ${remainingEligible} records still eligible (re-run is idempotent via the empty-pipelineStage pre-filter + the engine's noop short-circuit).`
        : "Backfill complete — no eligible records remain (zero records with empty Pipeline_Stage).",
    remaining_eligible_estimate: remainingEligible,
    total_wall_ms: Date.now() - t0,
    // Per-record results returned in their entirety so the operator can
    // grep / scroll — bounded by max_records (default 500 / hard cap 2000).
    results,
  });
}

function tally<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// GET is intentionally NOT implemented. The dry-run report endpoint
// (/api/admin/pipeline-state-backfill-dryrun) is the read-only surface.
// Hitting this URL with GET should not look like a soft option.
export async function GET() {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "GET is not implemented on the apply route by design. Use the dry-run report at /api/admin/pipeline-state-backfill-dryrun for read-only previews. Apply via POST with the confirm token.",
    },
    { status: 405 },
  );
}
