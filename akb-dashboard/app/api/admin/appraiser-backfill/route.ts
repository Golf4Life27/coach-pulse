// Phase 16.x / M — Appraiser backfill.
//
// GET /api/admin/appraiser-backfill[?apply=1&limit=N&include_manual_review=1&force=1]
//
// One-shot admin tool that exercises the Appraiser endpoints (ARV →
// Rehab → Buyer Intelligence) across the active pipeline so the new
// BroCard v1.3 pricing reflects on every active record, not just
// future ones. ~37 active deals have zero ARV / rehab / rent data per
// the 5/18 session-open briefing; Phase 4 is built but invisible until
// exercised.
//
// **M.1 shipped dry-run + audit.** **M.2 layers on apply mode +
// idempotency + rate-limit pacing** — Alex's explicit atomic boundary
// so apply behavior never exists without its safety rails.
//
// **Auth posture:** No app-level auth on this route. Follows the same
// convention as every other /api/admin/* endpoint in this codebase
// (d3-backfill-offer-fields, bulk-dead-stale-texted, etc.) — access
// control lives at the Vercel deployment layer (branch preview alias
// is private to Alex's team).
//
// **Lambda budget:** maxDuration = 300 (Hobby ceiling). Apply mode
// processes records serially with per-endpoint waits (ARV ~10s, Rehab
// ~20s, BuyerIntel ~10s) + pace_ms between records. Realistic
// throughput: ~6-10 records per invocation at default 2000ms pacing.
// Operator iterates with ?limit=N + re-runs until coverage is
// complete. The loop checks elapsed-vs-budget and stops cleanly so
// the final audit always lands.

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, getRehabSweepCandidates, getListing } from "@/lib/airtable";
import { audit, readRecentFromKv } from "@/lib/audit-log";
import { countCallsBySource24h } from "@/lib/spend/derive";
import {
  backfillDayKey,
  checkBackfillBudget,
  BACKFILL_DAY_TTL_S,
} from "@/lib/admin/backfill-budget";
import { noteWorkRun, noteZeroRun } from "@/lib/admin/retire-me-signal";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  aggregateBackfillStatus,
  classifyBackfillEligibility,
  estimateBackfillCost,
  readBackfillPaceMs,
  totalBackfillCost,
  type BackfillCostEstimate,
  type BackfillEligibility,
  type BackfillEndpointOutcome,
  type BackfillRecordApplyOutcome,
} from "@/lib/admin/appraiser-backfill";
import {
  planLegs,
  readsAgree,
  callsAvoided,
  readP2Config,
  rehabStableKey,
  rehabUnproducibleKey,
  REHAB_UNPRODUCIBLE_TTL_S,
  legFailureKey,
  STABLE_FLAG_TTL_S,
  FAILURE_COUNT_TTL_S,
  type LegName,
  type RecordLegPlan,
} from "@/lib/admin/p2-done-gate";
import { nextRehabSweepSlice } from "@/lib/admin/rehab-sweep-cursor";

function originFromReq(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

// Budget guard: stop the loop when remaining time wouldn't fit a full
// record (worst-case ~70s per record + pace). Leaves ~10s for the
// final audit + JSON response. Picked conservatively — better to
// return a partial result than to have the lambda 504 mid-write.
const MAX_RECORD_BUDGET_MS = 70_000;
const SAFETY_BUFFER_MS = 10_000;

// KV key for the rehab_ready rotating cursor (2026-07-27) — one cursor
// shared by every rehab_ready caller (the */5 cron never varies its
// params) so successive ticks advance through the pool instead of
// re-slicing the same top-N every time.
const REHAB_SWEEP_CURSOR_KEY = "rehab_ready";

/** RETIRED AS A GATE 2026-08-04 — kept only so the historical value and its
 *  characterization test remain readable. The sweep now runs against a
 *  dedicated daily record budget (lib/admin/backfill-budget), because a
 *  shared-TOTAL threshold cannot work here: sibling lanes burn ~79/day, so any
 *  value below that locks the sweep out permanently (every slot of 8/4:
 *  examined 3, processed 0) and any value above it bounds nothing.
 *
 *  Two premises below have also expired since it was written:
 *  (1) the 5-minute cadence it was sized against is now 30 minutes (48 runs/day,
 *      not 288);
 *  (2) "Until the terminal-stamp fix lands, this ceiling is the bound" — that
 *      fix LANDED the same day (Consolidation Night item E): a rehab 422 of
 *      no_photos_available now stamps `p2:rehab:no_photo_source:<id>` for 30
 *      days and the sweep skips the record, so the forever-re-photograph loop
 *      is already closed. The sentence was never updated, and it is why later
 *      sessions kept believing that waste was still live.
 *
 *  ── historical rationale, preserved ──
 *  WHY THIS EXISTED. This sweep was the #1 paid-API burner in the system:
 *  fired every 5 min over a ~1,751-record pool, its rehab leg calls
 *  collectPhotos(), which tries RentCast FIRST and UNCONDITIONALLY (2 paid
 *  calls: listings/sale then properties) before Firecrawl. 288 runs/day x
 *  3 records x 2 calls = 1,728/day — matching the observed 1,709-call
 *  spike on 2026-07-28 against a ~150/day baseline, on a 1,000-call/mo
 *  plan. Records that CANNOT produce a rehab (no photos available) never
 *  get rehab_estimated_at stamped, so they never satisfy the
 *  already_complete gate and the rotating cursor re-photographs them
 *  forever. Until the terminal-stamp fix lands, this ceiling is the bound.
 *
 *  DELIBERATELY LOWER THAN auto-underwrite-engaged's 150 ceiling, and it
 *  counts the SAME shared 24h paid-call total on purpose: this graveyard
 *  sweep must YIELD FIRST so the live-deal lane keeps its budget. Operator
 *  ruling 2026-07-13 (Spine recT0bGaqgqeh0z4s): ~95% of intake is
 *  unworkable, so paid data belongs on ENGAGED deals, not on every record.
 *  auto-underwrite-engaged obeyed that ruling; this sweep never got it. */
export function backfillPaid24hCeiling(): number {
  const raw = Number(process.env.BACKFILL_PAID_24H_CEILING);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60;
}

async function callEndpoint(
  origin: string,
  path: string,
  cookie: string | null,
  authorization: string | null = null,
  xVercelCron: string | null = null,
): Promise<BackfillEndpointOutcome> {
  const t = Date.now();
  try {
    const headers: Record<string, string> = {};
    // Forward dashboard cookie (original operator-driven path) AND any
    // bearer Authorization + x-vercel-cron header the caller arrived
    // with. The agent endpoints share the same auth waterfall as this
    // route, so a CRON_SECRET fire (Vercel cron) flows through to the
    // sub-requests cleanly. Spine rec6e6hYLuOpaLANf reconciliation —
    // 2026-06-04: before this, CRON_SECRET callers got 401 from every
    // sub-request because only the cookie was forwarded.
    if (cookie) headers.cookie = cookie;
    if (authorization) headers.authorization = authorization;
    if (xVercelCron) headers["x-vercel-cron"] = xVercelCron;
    const res = await fetch(`${origin}${path}`, { headers, cache: "no-store" });
    const elapsed = Date.now() - t;
    if (!res.ok) {
      // Best-effort error message — read body but don't fail on parse.
      const body = await res.text().catch(() => "");
      return {
        status: "error",
        http_status: res.status,
        elapsed_ms: elapsed,
        error: body ? body.slice(0, 500) : `HTTP ${res.status}`,
      };
    }
    return { status: "ok", http_status: res.status, elapsed_ms: elapsed, error: null };
  } catch (err) {
    return {
      status: "error",
      http_status: null,
      elapsed_ms: Date.now() - t,
      error: String(err).slice(0, 500),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const runtime = "nodejs";
// 300s ceiling per Vercel Hobby plan. M.1 is dry-run only (no
// per-record API calls) so this is conservative — actual elapsed for
// 37 records is well under a second. M.2 apply mode will exercise
// the full budget when ~3-4 records per request can fit.
export const maxDuration = 300;

interface BackfillRecordOutcome {
  record: BackfillEligibility;
  cost: BackfillCostEstimate;
  address: string;
  state: string | null;
  outreach_status: string | null;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit =
    limitParam != null ? Math.max(1, parseInt(limitParam, 10) || 0) : null;
  const includeManualReview =
    url.searchParams.get("include_manual_review") === "1";
  const force = url.searchParams.get("force") === "1";
  const apply = url.searchParams.get("apply") === "1";
  const paceMs = readBackfillPaceMs();

  // Skip + cursor support (2026-06-04): before this, `slice(0, limit)`
  // always took the SAME first N records, so a record with a structural
  // blocker (missing Building_SqFt → rehab 422) made a small-limit cron
  // recycle it forever without ever reaching the rest of the cluster.
  //   ?skip=recA,recB   — exclude these record ids outright.
  //   ?after=recX       — only process records whose id sorts AFTER recX
  //                       (a lexical cursor; pair with ?limit to page).
  // Sorting by id first makes `after` a deterministic cursor.
  const skipIds = new Set(
    (url.searchParams.get("skip") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("rec")),
  );
  const after = url.searchParams.get("after");

  // ── Selection mode (2026-06-05) ─────────────────────────────────
  //   default          — briefing-active set (Outreach_Status-based;
  //                       Negotiating/Response Received/Counter
  //                       Received/Offer Accepted + recent Texted/
  //                       Emailed). Kept for the ARV/rent sweeps.
  //   ?selection=rehab_ready
  //                    — records that can ACTUALLY produce a vision
  //                       rehab: Live_Status=Active AND a non-empty
  //                       Verification_URL. This stops the sweep from
  //                       crawling lex-first into the ~396 URL-less
  //                       actives (Firecrawl can't fire on them →
  //                       Street-View-only → rehab preflight refusal).
  //                       Expect ~1,751 candidates.
  const selection = url.searchParams.get("selection");
  const rehabReady = selection === "rehab_ready";
  const active = rehabReady
    ? await getRehabSweepCandidates()
    : await getActiveListingsForBrief({ recentDays: 7 });
  // Ordering (2026-06-11, spine recZNzKlsgtzlCLkY): rehab_ready sweeps
  // MOST-RECENTLY-VERIFIED first instead of lex-by-id. A freshly
  // re-verified record is sendable supply whose pricing is the binding
  // constraint — the sweep should convert it while it's still inside the
  // 48h outreach-freshness window, not after the lex cursor crawls to it
  // days later. Verify first, rehab second: a record that died at
  // re-verify (Live_Status=Off Market) drops out of getRehabSweepCandidates
  // entirely, so no vision call is ever spent on a dead listing. The
  // default (brief-active) selection keeps lex order — its ?after cursor
  // semantics depend on it.
  const ordered = rehabReady
    ? [...active].sort((a, b) => {
        const ta = a.lastVerified ? Date.parse(a.lastVerified) : -Infinity;
        const tb = b.lastVerified ? Date.parse(b.lastVerified) : -Infinity;
        if (tb !== ta) return tb - ta;
        return a.id.localeCompare(b.id);
      })
    : [...active].sort((a, b) => a.id.localeCompare(b.id));
  const filtered = ordered.filter(
    (l) => !skipIds.has(l.id) && (after ? l.id.localeCompare(after) > 0 : true),
  );
  // Rotating cursor (2026-07-27): rehab_ready's */5 cron always fires the
  // same params (?apply=1&selection=rehab_ready&limit=3, no &after=), so a
  // plain slice(0, limit) re-examined the SAME top-N every tick forever —
  // records deeper in the ~1,751-record pool were never reached. A KV
  // cursor (id-keyed, self-healing, wraps at the end) lets successive
  // ticks advance through the whole pool. An explicit ?after= is an
  // operator taking manual control and wins outright. KV-unreachable
  // fails open to today's top-N slice (see rehab-sweep-cursor.ts).
  let subset: typeof filtered;
  let cursorWrapped = false;
  if (rehabReady && after == null && limit != null) {
    const rotation = await nextRehabSweepSlice(REHAB_SWEEP_CURSOR_KEY, filtered, limit);
    subset = rotation.selected;
    cursorWrapped = rotation.wrapped;
  } else {
    subset = limit != null ? filtered.slice(0, limit) : filtered;
  }

  const outcomes: BackfillRecordOutcome[] = subset.map((l) => {
    const eligibility = classifyBackfillEligibility(l, {
      includeManualReview,
      force,
    });
    const cost = estimateBackfillCost(l);
    return {
      record: eligibility,
      cost,
      address: l.address,
      state: l.state,
      outreach_status: l.outreachStatus,
    };
  });

  const eligible = outcomes.filter((o) => o.record.eligible);
  const skipped = outcomes.filter((o) => !o.record.eligible);

  const skip_breakdown = {
    manual_review_low_arv: skipped.filter(
      (o) => o.record.skipReason === "manual_review_low_arv",
    ).length,
    already_complete: skipped.filter(
      (o) => o.record.skipReason === "already_complete",
    ).length,
    missing_zip: skipped.filter(
      (o) => o.record.skipReason === "missing_zip",
    ).length,
  };

  const totalCost = totalBackfillCost(eligible.map((o) => o.cost));

  // Cursor for the next page: the highest record id we examined this
  // call. A cron/operator passes ?after=<next_cursor> to advance past
  // the records already processed — so a structurally-blocked record
  // can't trap the sweep on subsequent fires.
  const next_cursor = subset.length > 0 ? subset[subset.length - 1].id : null;

  if (!apply) {
    await audit({
      agent: "appraiser",
      event: "backfill_dry_run",
      status: "confirmed_success",
      inputSummary: {
        limit,
        include_manual_review: includeManualReview,
        force,
        selection: rehabReady ? "rehab_ready" : "brief_active",
        active_total: active.length,
        examined: subset.length,
        cursor_wrapped: cursorWrapped,
      },
      outputSummary: {
        eligible_count: eligible.length,
        skipped_count: skipped.length,
        skip_breakdown,
        cost_estimate: totalCost,
        pace_ms_configured: paceMs,
      },
      decision: "dry_run",
      ms: Date.now() - t0,
    });

    return NextResponse.json({
      mode: "dry_run",
      apply_available: true,
      selection: rehabReady ? "rehab_ready" : "brief_active",
      pace_ms: paceMs,
      elapsed_ms: Date.now() - t0,
      active_total_in_airtable: active.length,
      candidate_count: active.length,
      examined: subset.length,
      next_cursor,
      cursor_wrapped: cursorWrapped,
      summary: {
        eligible: eligible.length,
        skipped: skipped.length,
        skip_breakdown,
        cost_estimate: totalCost,
      },
      eligible_sample: eligible.slice(0, 100).map((o) => ({
        recordId: o.record.recordId,
        // P2 done-gate preview (field-based; the apply run also consults
        // the KV stable/bench ledgers): which legs would actually fire.
        leg_plan: planLegs({
          arvValidatedAt: o.record.current.arv_validated_at,
          rehabEstimatedAt: o.record.current.rehab_estimated_at,
          estimatedMonthlyRent: o.record.current.estimated_monthly_rent,
          force,
          kvAvailable: false,
          rehabStable: false,
          failures: { arv: 0, rehab: 0, rent: 0 },
        }),
        address: o.address,
        state: o.state,
        outreach_status: o.outreach_status,
        current: o.record.current,
        cost: o.cost,
      })),
      skipped_sample: skipped.slice(0, 100).map((o) => ({
        recordId: o.record.recordId,
        address: o.address,
        outreach_status: o.outreach_status,
        skip_reason: o.record.skipReason,
        current: o.record.current,
      })),
    });
  }

  // ── Apply mode ─────────────────────────────────────────────────────────
  const origin = originFromReq(req);
  // ── Paid-call ceiling (2026-07-29) ───────────────────────────────────
  // Checked BEFORE any leg fires. See backfillPaid24hCeiling() for why
  // this sweep yields before the live-deal lane. Fails OPEN on an
  // unreadable meter — same posture as auto-underwrite-engaged: a KV
  // outage must not silently stall the pipeline. The loop-breaker and
  // the per-run `limit` remain the backstops in that case.
  // DEDICATED DAILY SLICE (2026-08-04) — replaces the shared-total ceiling.
  // The old gate compared TOTAL 24h paid calls across every lane against 60,
  // while sibling lanes alone burn ~79/day, so the sweep was locked out on
  // every slot of 8/4 (examined 3, processed 0, all day). No value of a
  // shared-total threshold fixes that: under the baseline it never opens,
  // above it it bounds nothing. The sweep now spends against its own daily
  // record budget; total exposure stays bounded by the global RentCast spend
  // ceiling, which refuses calls at the plan cap regardless.
  let backfillSpentToday: number | null = null;
  try {
    backfillSpentToday = Number((await kvProd.get(backfillDayKey(new Date()))) ?? "0") || 0;
  } catch {
    backfillSpentToday = null; // fail-open, same posture as every other brake
  }
  const budgetVerdict = checkBackfillBudget(backfillSpentToday);
  // Diagnostic only — no longer a gate. Kept in the audit row so the sweep's
  // spend stays legible next to the rest of the system's burn.
  let sweepRentcast24h: number | null = null;
  let sweepPaid24h: number | null = null;
  try {
    const counts = countCallsBySource24h(await readRecentFromKv(5000), new Date());
    sweepRentcast24h = counts.rentcast;
    sweepPaid24h = counts.rentcast + counts.attom;
  } catch {
    /* diagnostic only */
  }
  if (!budgetVerdict.allowed) {
    await audit({
      agent: "appraiser",
      event: "backfill_budget_skip",
      status: "confirmed_success",
      inputSummary: {
        selection: rehabReady ? "rehab_ready" : "brief_active",
        examined: subset.length,
        records_today: budgetVerdict.spentToday,
        daily_record_budget: budgetVerdict.budget,
        rentcast_24h: sweepRentcast24h,
        paid_24h: sweepPaid24h,
      },
      outputSummary: { skipped: true, reason: budgetVerdict.reason },
      decision: "skip_budget",
      ms: Date.now() - t0,
    });
    return NextResponse.json({
      ok: true,
      mode: "apply",
      skipped: true,
      reason: budgetVerdict.reason,
      records_today: budgetVerdict.spentToday,
      daily_record_budget: budgetVerdict.budget,
      rentcast_24h: sweepRentcast24h,
      paid_24h: sweepPaid24h,
      elapsed_ms: Date.now() - t0,
    });
  }
  // Never process more than the day's remaining allowance.
  if (subset.length > budgetVerdict.remaining) subset = subset.slice(0, budgetVerdict.remaining);

  const cookie = req.headers.get("cookie");
  // Forward the incoming bearer + x-vercel-cron so a CRON_SECRET fire
  // can drive this end-to-end without a dashboard cookie. (2026-06-04)
  const authorization = req.headers.get("authorization");
  const xVercelCron = req.headers.get("x-vercel-cron");

  const applied: BackfillRecordApplyOutcome[] = [];
  let truncated_by_budget = false;

  // ── P2 done-gate (#35) state ─────────────────────────────────────────
  const p2 = readP2Config();
  const byId = new Map(subset.map((l) => [l.id, l] as const));
  const appliedPlans: RecordLegPlan[] = [];
  let stableMarked = 0;
  const kvUp = kvConfigured();
  const skippedOutcome = (
    reason: NonNullable<BackfillEndpointOutcome["skipped_reason"]>,
  ): BackfillEndpointOutcome => ({
    status: "ok",
    http_status: null,
    elapsed_ms: 0,
    error: null,
    skipped_reason: reason,
  });
  const readFailure = async (recordId: string, leg: LegName): Promise<number> => {
    const raw = await kvProd.get(legFailureKey(recordId, leg));
    return raw == null ? 0 : Number(raw) || 0;
  };
  // On a leg error: extend the bench counter; on success: clear it.
  const recordLegResult = async (
    recordId: string,
    leg: LegName,
    outcome: BackfillEndpointOutcome,
    prior: number,
  ): Promise<void> => {
    if (!kvUp || outcome.skipped_reason) return;
    try {
      if (outcome.status === "error") {
        await kvProd.setEx(legFailureKey(recordId, leg), String(prior + 1), FAILURE_COUNT_TTL_S);
      } else if (prior > 0) {
        await kvProd.del(legFailureKey(recordId, leg));
      }
    } catch {
      /* bench ledger is advisory */
    }
  };

  for (let i = 0; i < eligible.length; i++) {
    const o = eligible[i];
    const elapsed = Date.now() - t0;
    const remaining = maxDuration * 1000 - elapsed;
    // Stop cleanly if we wouldn't have enough room for another full
    // record + the trailing audit write. Better to return partial
    // results than to have Vercel kill us mid-write.
    if (remaining < MAX_RECORD_BUDGET_MS + SAFETY_BUFFER_MS) {
      truncated_by_budget = true;
      break;
    }

    const recordT0 = Date.now();

    // ── P2 done-gate: which legs does this record still OWE? A completed
    // leg never re-buys its call; the rehab leg gets exactly one
    // confirmation read, then a stable mark stops it forever (the
    // reccyLTGRZzMmbe2w class: 5 identical vision reads on the 5-min cron).
    const listing = byId.get(o.record.recordId) ?? null;
    let kvAvailable = kvUp;
    let rehabStable = false;
    let rehabUnproducible = false;
    let failures = { arv: 0, rehab: 0, rent: 0 };
    if (kvUp) {
      try {
        const [stableFlag, unproducibleFlag, fArv, fRehab, fRent] = await Promise.all([
          kvProd.get(rehabStableKey(o.record.recordId)),
          kvProd.get(rehabUnproducibleKey(o.record.recordId)),
          readFailure(o.record.recordId, "arv"),
          readFailure(o.record.recordId, "rehab"),
          readFailure(o.record.recordId, "rent"),
        ]);
        rehabStable = stableFlag != null;
        rehabUnproducible = unproducibleFlag != null;
        failures = { arv: fArv, rehab: fRehab, rent: fRent };
      } catch {
        kvAvailable = false; // ledger unreadable → fail toward not spending
      }
    }
    const plan = planLegs({
      arvValidatedAt: o.record.current.arv_validated_at,
      rehabEstimatedAt: o.record.current.rehab_estimated_at,
      estimatedMonthlyRent: o.record.current.estimated_monthly_rent,
      force,
      kvAvailable,
      rehabStable,
      rehabUnproducible,
      failures,
      failureCap: p2.failureCap,
    });
    appliedPlans.push(plan);
    // Snapshot the PRIOR vision read before a new one lands (consecutive-
    // agreement needs read N-1; the fields hold it until the endpoint
    // overwrites them).
    const prevRead = {
      conf: listing?.rehabConfidenceScore ?? null,
      mid: listing?.estRehabMid ?? null,
    };

    const arv =
      plan.arv === "run"
        ? await callEndpoint(
            origin,
            `/api/agents/appraiser/arv/${o.record.recordId}`,
            cookie,
            authorization,
            xVercelCron,
          )
        : skippedOutcome(plan.arv);
    const rehab =
      plan.rehab === "run"
        ? await callEndpoint(
            origin,
            `/api/agents/appraiser/rehab/${o.record.recordId}`,
            cookie,
            authorization,
            xVercelCron,
          )
        : skippedOutcome(plan.rehab);
    const buyerIntel =
      plan.rent === "run"
        ? await callEndpoint(
            origin,
            `/api/agents/appraiser/buyer-intelligence/${o.record.recordId}`,
            cookie,
            authorization,
            xVercelCron,
          )
        : skippedOutcome(plan.rent);

    await recordLegResult(o.record.recordId, "arv", arv, failures.arv);
    await recordLegResult(o.record.recordId, "rehab", rehab, failures.rehab);
    await recordLegResult(o.record.recordId, "rent", buyerIntel, failures.rent);

    // ── Terminal no-photo-source answer (item E, 2026-07-29): a rehab 422
    // of no_photos_available / street_view_only_insufficient is an ANSWER,
    // not a failure — stamp the 30d flag so the sweep stops re-buying
    // photo pulls for a property that has no photo source. Without this,
    // the failure bench looped: 5 paid rounds → 7d bench → 5 more, forever.
    if (
      kvAvailable &&
      rehab.status === "error" &&
      rehab.http_status === 422 &&
      typeof rehab.error === "string" &&
      /no_photos_available|street_view_only_insufficient/.test(rehab.error)
    ) {
      try {
        await kvProd.setEx(
          rehabUnproducibleKey(o.record.recordId),
          new Date().toISOString(),
          REHAB_UNPRODUCIBLE_TTL_S,
        );
      } catch {
        /* flag is an optimization — a write failure just means one more round */
      }
    }

    // ── Stability mark: when a CONFIRMATION read (a prior read existed)
    // lands and agrees with it (conf equal + mid within ±$5), the record
    // is done — the vision leg never fires again.
    if (
      kvAvailable &&
      plan.rehab === "run" &&
      rehab.status === "ok" &&
      prevRead.mid != null
    ) {
      try {
        const fresh = await getListing(o.record.recordId);
        const nextRead = {
          conf: fresh?.rehabConfidenceScore ?? null,
          mid: fresh?.estRehabMid ?? null,
        };
        if (readsAgree(prevRead, nextRead, p2.stableDeltaUsd)) {
          await kvProd.setEx(
            rehabStableKey(o.record.recordId),
            new Date().toISOString(),
            STABLE_FLAG_TTL_S,
          );
          stableMarked++;
        }
      } catch {
        /* stability mark is best-effort — worst case one more read */
      }
    }

    const aggregate = aggregateBackfillStatus(arv.status, rehab.status, buyerIntel.status);

    const outcome: BackfillRecordApplyOutcome = {
      recordId: o.record.recordId,
      status: aggregate,
      arv,
      rehab,
      buyer_intelligence: buyerIntel,
      total_elapsed_ms: Date.now() - recordT0,
    };
    applied.push(outcome);

    // Per-record audit so Maverick load-state can surface backfill
    // progress in real time + downstream Pulse can baseline endpoint
    // failure rates across the active pipeline.
    await audit({
      agent: "appraiser",
      event: "backfill_record_applied",
      status: aggregate === "ok" ? "confirmed_success" : "confirmed_failure",
      recordId: o.record.recordId,
      inputSummary: {
        address: o.address,
        state: o.state,
        outreach_status: o.outreach_status,
      },
      outputSummary: {
        aggregate_status: aggregate,
        arv: { status: arv.status, http: arv.http_status, ms: arv.elapsed_ms, error: arv.error },
        rehab: { status: rehab.status, http: rehab.http_status, ms: rehab.elapsed_ms, error: rehab.error },
        buyer_intelligence: {
          status: buyerIntel.status,
          http: buyerIntel.http_status,
          ms: buyerIntel.elapsed_ms,
          error: buyerIntel.error,
        },
      },
      decision: aggregate,
      ms: outcome.total_elapsed_ms,
    });

    // Pace between records. Skip the wait on the last iteration —
    // there's no next record to pace against.
    if (paceMs > 0 && i < eligible.length - 1) {
      await sleep(paceMs);
    }
  }

  const apply_summary = {
    total: applied.length,
    ok: applied.filter((a) => a.status === "ok").length,
    partial: applied.filter((a) => a.status === "partial").length,
    error: applied.filter((a) => a.status === "error").length,
    truncated_by_budget,
    remaining_eligible: eligible.length - applied.length,
  };

  // P2 done-gate burn quantification (#35): the calls each skip avoided
  // this run, by vendor — the honest counter for what the gate saves.
  const p2Summary = {
    calls_avoided: callsAvoided(appliedPlans),
    stable_marked: stableMarked,
    legs_skipped: {
      arv: appliedPlans.filter((p) => p.arv !== "run").length,
      rehab: appliedPlans.filter((p) => p.rehab !== "run").length,
      rent: appliedPlans.filter((p) => p.rent !== "run").length,
    },
    stable_delta_usd: p2.stableDeltaUsd,
    failure_cap: p2.failureCap,
  };

  // Charge the day's record budget for the work actually attempted. Atomic
  // (lib/maverick/oauth/kv incrBy) so overlapping slots cannot both read the
  // same total and write the same increment — the lost-update race that made
  // the RentCast meter read ~4x low.
  if (applied.length > 0) {
    try {
      const key = backfillDayKey(new Date());
      const total = await kvProd.incrBy(key, applied.length);
      if (total === applied.length) await kvProd.expire(key, BACKFILL_DAY_TTL_S);
    } catch {
      /* meter write failure just means one more run's worth of allowance */
    }
  }

  await audit({
    agent: "appraiser",
    event: "backfill_apply_run",
    status: apply_summary.error === applied.length && applied.length > 0
      ? "confirmed_failure"
      : "confirmed_success",
    inputSummary: {
      limit,
      include_manual_review: includeManualReview,
      force,
      pace_ms: paceMs,
      eligible_total: eligible.length,
      selection: rehabReady ? "rehab_ready" : "brief_active",
      cursor_wrapped: cursorWrapped,
    },
    outputSummary: {
      ...apply_summary,
      cost_estimate: totalCost,
      p2_done_gate: p2Summary,
    },
    decision: truncated_by_budget ? "applied_truncated_by_budget" : "applied",
    ms: Date.now() - t0,
  });

  // 2026-06-11 — retire-me signal. When the eligible cohort empties
  // across ZERO_RUN_THRESHOLD ticks the cron alerts so the operator
  // knows to retire the slot (cohort drained means the backfill earned
  // its slot; no self-modification of vercel.json).
  if (eligible.length === 0) {
    await noteZeroRun("appraiser-backfill", {
      cron_path: "/api/admin/appraiser-backfill?apply=1&selection=rehab_ready&limit=3",
      reason: "no_eligible_records",
    });
  } else {
    await noteWorkRun("appraiser-backfill");
  }

  return NextResponse.json({
    mode: "apply",
    apply_available: true,
    pace_ms: paceMs,
    elapsed_ms: Date.now() - t0,
    active_total_in_airtable: active.length,
    examined: subset.length,
    next_cursor,
    cursor_wrapped: cursorWrapped,
    summary: {
      eligible: eligible.length,
      skipped: skipped.length,
      skip_breakdown,
      cost_estimate: totalCost,
      apply: apply_summary,
      p2_done_gate: p2Summary,
    },
    applied,
    skipped_sample: skipped.slice(0, 100).map((o) => ({
      recordId: o.record.recordId,
      address: o.address,
      outreach_status: o.outreach_status,
      skip_reason: o.record.skipReason,
      current: o.record.current,
    })),
  });
}
