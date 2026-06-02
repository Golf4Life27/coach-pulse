// Pipeline_State backfill — server-side sweep (CRON_SECRET-gated).
// @agent: maverick / orchestrator
//
// POST or GET /api/cron/pipeline-state-backfill-sweep
//   query / body (both optional):
//     max_records?: number   (default 500, clamped to RUNNER_HARD_MAX_RECORDS)
//     concurrency?: number   (default 4, clamped to RUNNER_HARD_MAX_CONCURRENCY)
//
// Built so the operator never runs the backfill from a browser console
// again — invocation goes through Vercel-side env secrets, not a copy-
// pasted cookie. Auth: the standard waterfall with the CRON_SECRET
// stage active (Authorization: Bearer + x-vercel-cron:1 header). The
// OAuth stage is also accepted so Maverick MCP / GitHub-Actions paths
// work without a separate CRON_SECRET share. Dashboard cookie is NOT
// accepted here — the cookie-gated UI surface is the original apply
// route.
//
// Same six guardrails as the apply route: they all live in the runner
// (`lib/pipeline-state/backfill-runner.ts`), not the route. Adding a
// new caller cannot bypass them because writes only happen through
// `runBackfillBatch`.
//
// Confirm-token is intentionally NOT required here — the CRON_SECRET +
// `x-vercel-cron` header pair (or an OAuth access token) is itself the
// gate. Idempotency + Canon §9 blocklist hard-guard + the 13-stage
// legal-edge engine still apply, so the worst-case outcome of an
// accidental fire is a noop-on-already-populated mass-skip.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  runBackfillBatch,
  RUNNER_HARD_MAX_RECORDS,
  RUNNER_HARD_MAX_CONCURRENCY,
} from "@/lib/pipeline-state/backfill-runner";

export const runtime = "nodejs";
export const maxDuration = 300;

interface SweepParams {
  max_records?: number;
  concurrency?: number;
}

function parseQuery(req: Request): SweepParams {
  const url = new URL(req.url);
  const max = url.searchParams.get("max_records");
  const conc = url.searchParams.get("concurrency");
  return {
    max_records: max && /^\d+$/.test(max) ? parseInt(max, 10) : undefined,
    concurrency: conc && /^\d+$/.test(conc) ? parseInt(conc, 10) : undefined,
  };
}

async function parseBody(req: Request): Promise<SweepParams> {
  try {
    const j = (await req.json()) as { max_records?: unknown; concurrency?: unknown };
    return {
      max_records: typeof j.max_records === "number" ? j.max_records : undefined,
      concurrency: typeof j.concurrency === "number" ? j.concurrency : undefined,
    };
  } catch {
    return {};
  }
}

async function handle(req: Request, params: SweepParams) {
  const t0 = Date.now();

  // Auth waterfall — accepts OAuth or CRON_SECRET (+ x-vercel-cron:1).
  // Dashboard cookie path intentionally NOT accepted here.
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) {
    return NextResponse.json(
      {
        error: "unauthorized",
        reason: auth.reason,
        message:
          "This route requires CRON_SECRET (Authorization: Bearer + x-vercel-cron:1) or a valid OAuth access token. Dashboard cookie path is rejected here — use /api/admin/pipeline-state-backfill-apply for that.",
      },
      { status: 401 },
    );
  }
  // Pulse safety: also require KV configured for OAuth path (token store).
  // For pure CRON_SECRET fires, KV isn't strictly needed.
  if (auth.kind !== "cron" && auth.kind !== "oauth") {
    return NextResponse.json(
      {
        error: "unauthorized",
        reason: "unsupported_auth_kind",
        message: `auth_kind=${auth.kind} not accepted on this route`,
      },
      { status: 401 },
    );
  }
  // bearer_dev is intentionally NOT supported here (production safety).
  // KV warning surface for operator visibility:
  if (auth.kind === "oauth" && !kvConfigured()) {
    return NextResponse.json(
      {
        error: "kv_not_configured",
        message: "OAuth path requires Vercel KV to be configured.",
      },
      { status: 500 },
    );
  }

  // Pre-execution refusal on oversized requests (mirrors apply route).
  if (
    typeof params.max_records === "number" &&
    params.max_records > RUNNER_HARD_MAX_RECORDS
  ) {
    return NextResponse.json(
      {
        error: "max_records_exceeds_safe_cap",
        message: `Requested max_records=${params.max_records} exceeds the safe cap of ${RUNNER_HARD_MAX_RECORDS} per invocation.`,
        hard_max_records: RUNNER_HARD_MAX_RECORDS,
      },
      { status: 413 },
    );
  }
  if (
    typeof params.concurrency === "number" &&
    params.concurrency > RUNNER_HARD_MAX_CONCURRENCY
  ) {
    return NextResponse.json(
      {
        error: "concurrency_exceeds_safe_cap",
        hard_max_concurrency: RUNNER_HARD_MAX_CONCURRENCY,
      },
      { status: 413 },
    );
  }

  try {
    const run = await runBackfillBatch({
      max_records: params.max_records,
      concurrency: params.concurrency,
      audit_event: "pipeline_state_backfill_sweep",
      attribution: "maverick",
      triggered_by_label: "server_side_sweep",
      audit_context: { caller: "cron_sweep", auth_kind: auth.kind },
    });
    // Structured one-line summary log — surfaces the per-run summary in
    // Vercel runtime logs. Vercel's log-table preview truncates at ~30
    // chars but the full payload is still in the log entry; ops can
    // expand the row or use the `vercel logs` CLI to read it. Sole
    // purpose is operator-visibility; not a replacement for the audit
    // entry the runner already wrote.
    console.log(
      "[pipeline_state_backfill_sweep]",
      JSON.stringify({
        ok: run.ok,
        caller: "cron_sweep",
        auth_kind: auth.kind,
        summary: run.summary,
        remaining_eligible_estimate: run.remaining_eligible_estimate,
        total_wall_ms: run.total_wall_ms,
      }),
    );
    return NextResponse.json({
      ok: run.ok,
      caller: "cron_sweep",
      auth_kind: auth.kind,
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
      event: "pipeline_state_backfill_sweep",
      status: "confirmed_failure",
      inputSummary: { caller: "cron_sweep", auth_kind: auth.kind },
      outputSummary: { stage: "runner_threw", duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { ok: false, error: "runner_failed", message: msg },
      { status: 500 },
    );
  }
}

// Vercel cron invocations use GET; manual GitHub-Actions trigger uses POST.
// Both supported; both share the same body/query parsing.
export async function GET(req: Request) {
  return handle(req, parseQuery(req));
}

export async function POST(req: Request) {
  const fromBody = await parseBody(req);
  const fromQuery = parseQuery(req);
  return handle(req, {
    max_records: fromBody.max_records ?? fromQuery.max_records,
    concurrency: fromBody.concurrency ?? fromQuery.concurrency,
  });
}
