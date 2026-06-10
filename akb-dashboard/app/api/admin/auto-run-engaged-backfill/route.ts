// 2026-06-10 ruling — backfill the current Response Received cohort.
// @agent: appraiser
//
// One-shot admin tool that finds every Response Received listing without
// a fresh ARV and fires the auto-run pipeline (lib/appraiser/
// auto-run-on-engaged.autoRunOnEngaged) the same way scan-replies does
// when a new transition lands. Closes the gap on records that flipped
// engaged BEFORE the event-driven kick shipped.
//
// GET /api/admin/auto-run-engaged-backfill
//   ?apply=1           run the kicks (default dry-run)
//   ?limit=N           cap candidates per invocation (default 8)
//   ?force=1           include records that already have arvValidatedAt
//                      (refresh instead of skip)
//   ?skip_rehab=1      ARV only, don't fire rehab (faster + safer when
//                      vision is hot)
//   ?pace_ms=N         delay between records (default 2000)
//
// Auth posture mirrors admin/appraiser-backfill: no app-level guard,
// relies on the deployment-layer alias being private to the operator
// team. Same convention as bulk-dead-stale-texted, d3-backfill-offer-
// fields, dispose-listing, etc.
//
// Budget: maxDuration=300 (Hobby ceiling). ARV ~15s + pace 2s per record
// → ~17 records per invocation worst-case. Realistically 8-12, since
// some kicks return faster on dry-cache hits. Operator iterates with
// ?limit until coverage is complete; the response carries a
// next_cursor for pagination.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  autoRunOnEngaged,
  originFromRequest,
  type EngagedAutoRunResult,
} from "@/lib/appraiser/auto-run-on-engaged";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 8;
const DEFAULT_PACE_MS = 2000;
// Same budget guard pattern as admin/appraiser-backfill: stop the loop
// when remaining time wouldn't fit a full ARV (worst-case ~25s) + the
// pace gap + a 10s buffer for the closing audit + JSON response.
const MAX_RECORD_BUDGET_MS = 30_000;
const SAFETY_BUFFER_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BackfillCandidate {
  recordId: string;
  address: string;
  state: string | null;
  outreachStatus: string | null;
  arvValidatedAt: string | null | undefined;
  rehabEstimatedAt: string | null | undefined;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const force = url.searchParams.get("force") === "1";
  const skipRehab = url.searchParams.get("skip_rehab") === "1";
  const limitParam = url.searchParams.get("limit");
  const limit =
    limitParam != null
      ? Math.max(1, parseInt(limitParam, 10) || DEFAULT_LIMIT)
      : DEFAULT_LIMIT;
  const paceMsParam = url.searchParams.get("pace_ms");
  const paceMs =
    paceMsParam != null
      ? Math.max(0, parseInt(paceMsParam, 10) || DEFAULT_PACE_MS)
      : DEFAULT_PACE_MS;
  const afterCursor = url.searchParams.get("after");

  const listings = await getListings();
  const engaged = listings.filter(
    (l) => (l.outreachStatus ?? "") === "Response Received",
  );

  // Candidates: Response Received AND (no ARV OR ?force=1). Sorted by id
  // so ?after=<cursor> is a deterministic pager — same pattern as
  // admin/appraiser-backfill.
  const candidates: BackfillCandidate[] = engaged
    .filter((l) => force || l.arvValidatedAt == null)
    .filter((l) => (afterCursor ? l.id.localeCompare(afterCursor) > 0 : true))
    .map((l) => ({
      recordId: l.id,
      address: l.address,
      state: l.state,
      outreachStatus: l.outreachStatus,
      arvValidatedAt: l.arvValidatedAt,
      rehabEstimatedAt: l.rehabEstimatedAt,
    }))
    .sort((a, b) => a.recordId.localeCompare(b.recordId));

  const subset = candidates.slice(0, limit);
  const nextCursor = subset.length > 0 ? subset[subset.length - 1].recordId : null;

  if (!apply) {
    await audit({
      agent: "appraiser",
      event: "auto_run_engaged_backfill_dry_run",
      status: "confirmed_success",
      inputSummary: { limit, force, skip_rehab: skipRehab },
      outputSummary: {
        engaged_total: engaged.length,
        candidate_total: candidates.length,
        examined: subset.length,
      },
      decision: "dry_run",
      ms: Date.now() - t0,
    });
    return NextResponse.json({
      mode: "dry_run",
      apply_available: true,
      engaged_total: engaged.length,
      candidate_total: candidates.length,
      examined: subset.length,
      next_cursor: nextCursor,
      candidate_sample: subset.slice(0, 50),
      elapsed_ms: Date.now() - t0,
    });
  }

  // ── Apply mode ──────────────────────────────────────────────────────
  const origin = originFromRequest(req);
  const results: EngagedAutoRunResult[] = [];
  let truncatedByBudget = false;

  for (let i = 0; i < subset.length; i++) {
    const elapsed = Date.now() - t0;
    const remaining = maxDuration * 1000 - elapsed - SAFETY_BUFFER_MS;
    if (remaining < MAX_RECORD_BUDGET_MS) {
      truncatedByBudget = true;
      break;
    }

    const r = await autoRunOnEngaged({
      recordId: subset[i].recordId,
      origin,
      skipRehab,
    });
    results.push(r);

    if (i < subset.length - 1 && paceMs > 0) {
      await sleep(paceMs);
    }
  }

  await audit({
    agent: "appraiser",
    event: "auto_run_engaged_backfill_applied",
    status: results.every((r) => r.arvOk) ? "confirmed_success" : "uncertain",
    inputSummary: { limit, force, skip_rehab: skipRehab, pace_ms: paceMs },
    outputSummary: {
      attempted: results.length,
      arv_ok: results.filter((r) => r.arvOk).length,
      rehab_kicked: results.filter((r) => r.rehabKicked).length,
      truncated_by_budget: truncatedByBudget,
    },
    decision: "applied",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: "apply",
    engaged_total: engaged.length,
    candidate_total: candidates.length,
    examined: subset.length,
    attempted: results.length,
    arv_ok: results.filter((r) => r.arvOk).length,
    rehab_kicked: results.filter((r) => r.rehabKicked).length,
    truncated_by_budget: truncatedByBudget,
    next_cursor:
      results.length > 0 ? results[results.length - 1].recordId : nextCursor,
    results,
    elapsed_ms: Date.now() - t0,
  });
}
