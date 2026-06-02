// Pipeline_State backfill — GATED APPLY route (dashboard-cookie path).
// @agent: maverick / orchestrator
//
// POST /api/admin/pipeline-state-backfill-apply
//   body: {
//     confirm: "BACKFILL-PIPELINE-STATE-YYYY-MM-DD",
//     max_records?: number,
//     concurrency?: number
//   }
//
// Original gated apply surface (decision rechGJ32oW9Qmv8wp). Kept as
// the operator-visible UI path. All write logic lives in
// `lib/pipeline-state/backfill-runner.runBackfillBatch`; the auth +
// confirm-token + 413-class refusal stay here.
//
// 2026-06-01 (sweep build): runner-wide HARD_MAX_RECORDS reduced
// 2000→1000 + WALL_CLOCK_BUDGET_MS 270_000→240_000 (per-incident
// 2YBolmqJ2OHX0MhrHJgqiDakbopi5dmz post-mortem — see runner header).
// Companion sweep route /api/cron/pipeline-state-backfill-sweep
// (CRON_SECRET-gated) added so server-side execution replaces the
// browser-console workflow going forward.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { hasDashboardSession } from "@/lib/maverick/oauth/auth-waterfall";
import {
  confirmTokenMatches,
  expectedConfirmToken,
} from "@/lib/pipeline-state/backfill-apply";
import {
  runBackfillBatch,
  RUNNER_HARD_MAX_RECORDS,
  RUNNER_HARD_MAX_CONCURRENCY,
} from "@/lib/pipeline-state/backfill-runner";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const t0 = Date.now();

  // Gate 1: dashboard cookie ONLY.
  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    return NextResponse.json(
      {
        error: "unauthorized",
        reason: "dashboard_session_required",
        message:
          "This route is gated to the authenticated dashboard session ONLY (akb-auth cookie). OAuth / CRON_SECRET / dev-bearer are intentionally refused. Use /api/cron/pipeline-state-backfill-sweep for server-side execution.",
      },
      { status: 401 },
    );
  }

  // Parse body.
  let body: { confirm?: unknown; max_records?: unknown; concurrency?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "POST body must be valid JSON." },
      { status: 400 },
    );
  }

  // Gate 2: confirm token (today's UTC date).
  const supplied =
    typeof body.confirm === "string" ? (body.confirm as string) : null;
  const now = new Date();
  if (!confirmTokenMatches(supplied, now)) {
    return NextResponse.json(
      {
        error: "confirm_required",
        message: `Body must include \`confirm\` matching today's UTC token.`,
        expected_token: expectedConfirmToken(now),
        hint: "Operator must type today's date explicitly — replay protection + intentional gesture.",
      },
      { status: 400 },
    );
  }

  // Pre-execution refusal if the operator asks for more than the runner
  // can safely complete inside the lambda budget. Surfaces a 413 with a
  // clear hint so the operator doesn't re-hit the 500-by-timeout class.
  if (
    typeof body.max_records === "number" &&
    body.max_records > RUNNER_HARD_MAX_RECORDS
  ) {
    return NextResponse.json(
      {
        error: "max_records_exceeds_safe_cap",
        message: `Requested max_records=${body.max_records} exceeds the safe cap of ${RUNNER_HARD_MAX_RECORDS} per invocation (reduced from 2000 after the 2026-05-31 timeout incident). Re-run the route to continue — idempotency guarantees safe resumption.`,
        hard_max_records: RUNNER_HARD_MAX_RECORDS,
      },
      { status: 413 },
    );
  }
  if (
    typeof body.concurrency === "number" &&
    body.concurrency > RUNNER_HARD_MAX_CONCURRENCY
  ) {
    return NextResponse.json(
      {
        error: "concurrency_exceeds_safe_cap",
        message: `Requested concurrency=${body.concurrency} exceeds the safe cap of ${RUNNER_HARD_MAX_CONCURRENCY}.`,
        hard_max_concurrency: RUNNER_HARD_MAX_CONCURRENCY,
      },
      { status: 413 },
    );
  }

  try {
    const run = await runBackfillBatch({
      max_records:
        typeof body.max_records === "number" ? body.max_records : undefined,
      concurrency:
        typeof body.concurrency === "number" ? body.concurrency : undefined,
      audit_event: "pipeline_state_backfill_apply",
      attribution: "maverick",
      triggered_by_label: "operator_dashboard",
      audit_context: {
        confirm_token_date: expectedConfirmToken(now),
        caller: "dashboard_cookie",
      },
    });
    return NextResponse.json({
      ok: run.ok,
      summary: run.summary,
      next_step: run.next_step,
      remaining_eligible_estimate: run.remaining_eligible_estimate,
      total_wall_ms: run.total_wall_ms,
      results: run.results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "maverick",
      event: "pipeline_state_backfill_apply",
      status: "confirmed_failure",
      inputSummary: { caller: "dashboard_cookie" },
      outputSummary: { stage: "runner_threw", duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { ok: false, error: "runner_failed", message: msg },
      { status: 500 },
    );
  }
}

// GET intentionally NOT implemented. Apply must not look like a soft option.
export async function GET() {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "GET is not implemented on the apply route by design. Use the dry-run report at /api/admin/pipeline-state-backfill-dryrun for read-only previews, or POST here with the confirm token. Server-side execution uses /api/cron/pipeline-state-backfill-sweep.",
    },
    { status: 405 },
  );
}
