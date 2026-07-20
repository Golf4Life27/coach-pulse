// Auto-underwrite engaged deals (P1.2, 2026-07-13). @agent: appraiser
//
// Zero-click offer-readiness. The manual Run buttons are dead to the operator
// and the inline scan-replies trigger only catches an SMS Texted→Response
// Received flip. This cron is the channel-agnostic catch-all: every engaged,
// Auto-Proceed deal lacking a fresh (<14d) underwrite gets ARV → rehab →
// buyer-ceiling computed automatically — including the legacy/email/manual
// advances the inline trigger misses (3123 Sunbeam is the anchor: live,
// Negotiating, revived by hand, no ARV/rehab).
//
// GATES: Execution_Path = Auto Proceed (past the intake math gate — never
// raw intake), freshness dedupe (skip records priced <14d ago), NEEDS_DATA
// retry backoff (a failed attempt doesn't starve the queue), and a paid-call
// 24h HARD CEILING (RentCast + ATTOM — protects the vendor caps; per-shape
// runaway is enforced downstream by the paid-call loop-breaker). Bounded
// per run.
//
// BUDGET-GATE FIX (2026-07-13 decision-math build): this run was originally
// gated on resolveSeedBudget — the $25/day FRONTIER-SEEDING throttle — which
// the */5 appraiser-backfill + seed sweeps exhaust every day, so the engaged
// lane never processed a single target (14:25Z run: 200 OK, zero sub-calls;
// Mayfield/716 8th/Bennett all blank). Engaged deals are the MONEY lane —
// the reply justified the spend (2026-06-10 ruling) — and an engaged
// underwrite is not a seed. The gate is now a hard 24h paid-call ceiling
// (RENTCAST_24H_HARD_CEILING, default 150 — counts RentCast + ATTOM since
// the 2026-07-20 promotion moved comp billing to ATTOM) + the per-run
// limit: worst case ~20 calls/run, 2 scheduled runs/day.
//
// EVERY TARGET NOW PERSISTS A DECISION: on underwrite success the decision
// math lands (Buyer_Ceiling / Deal_Spread / verdict); on ARV failure the
// record gets Decision_Verdict=NEEDS_DATA with the failure named — a silent
// blank is no longer possible, and the backoff keys off that stamp.
//
// GET  ?dry=1 (default)  list the cohort, spend nothing.
//      ?apply=1          compute for up to `limit` targets.
//      ?limit=N          cap (default 4, max 10) — vision is 1-3 min each.

import { NextResponse } from "next/server";
import { getListing, getListings } from "@/lib/airtable";
import { audit, readRecentFromKv } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { countCallsBySource24h } from "@/lib/spend/derive";
import { selectEngagedUnderwriteTargets } from "@/lib/appraiser/engaged-underwrite-select";
import { autoRunOnEngaged, originFromRequest } from "@/lib/appraiser/auto-run-on-engaged";
import { persistDecisionMath } from "@/lib/decision-persist";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 10;
// Minimum wall-clock to START a target: ARV (~15s) + buyer-intel (~20s) +
// reprice. Was 200s (a full vision-rehab reservation), which let only ~1
// target run per tick and stretched a 4-deep queue across 2 days. Rehab is
// budget-aware inside autoRunOnEngaged (REHAB_BUDGET_MS): it runs when the
// remaining budget fits, else records skipped_budget — and the */5
// appraiser-backfill (rehab_ready) fills the gap within the hour. ARV +
// ceiling math for every target beats full math for one.
const PER_TARGET_BUDGET_MS = 60_000;

/** Hard 24h paid-call ceiling for this lane to run (protects the vendor
 *  caps without starving the money lane on the seed budget). Since the
 *  ATTOM promotion (2026-07-20) comp pulls bill ATTOM, not RentCast, so
 *  the guard counts BOTH sources — otherwise the lane's only whole-run
 *  spend bound would never see its own comp calls. Env name kept for
 *  the already-deployed Vercel setting. */
export function paidCalls24hHardCeiling(): number {
  const raw = Number(process.env.RENTCAST_24H_HARD_CEILING);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 150;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);

  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) authKind = "dashboard_session";
  else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }
  const forceRun = url.searchParams.get("force_run") === "1";
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true" && !forceRun) {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const apply = url.searchParams.get("apply") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : DEFAULT_LIMIT;
  const now = new Date();

  let all: Listing[];
  try {
    all = await getListings();
  } catch (err) {
    return NextResponse.json({ error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  const targets = selectEngagedUnderwriteTargets(all, now);
  const preview = targets.slice(0, limit).map((l) => ({
    record_id: l.id,
    address: l.address,
    status: l.outreachStatus,
    source_version: l.sourceVersion,
    arv_validated_at: l.arvValidatedAt ?? null,
  }));

  if (!apply) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      auth_kind: authKind,
      engaged_stale_total: targets.length,
      would_run: preview,
      duration_ms: Date.now() - t0,
    });
  }

  // Hard 24h paid-call ceiling (RentCast + ATTOM) — the engaged lane's
  // only whole-run guard (see BUDGET-GATE FIX header). Fail-open on an
  // unreadable meter: this lane is bounded (limit × ~5 calls) and the
  // loop-breaker guards per-shape runaway on BOTH vendors, so a
  // monitoring outage must not stall live deals.
  const ceiling = paidCalls24hHardCeiling();
  let rentcast24h: number | null = null;
  let attom24h: number | null = null;
  let paid24h: number | null = null;
  try {
    const entries = await readRecentFromKv(5000);
    const counts = countCallsBySource24h(entries, now);
    rentcast24h = counts.rentcast;
    attom24h = counts.attom;
    paid24h = counts.rentcast + counts.attom;
  } catch {
    paid24h = null;
  }
  if (paid24h != null && paid24h >= ceiling) {
    await audit({
      agent: "appraiser",
      event: "auto_underwrite_engaged_budget_skip",
      status: "confirmed_success",
      inputSummary: { engaged_stale_total: targets.length, rentcast_24h: rentcast24h, attom_24h: attom24h, paid_24h: paid24h, ceiling },
      outputSummary: { skipped: true, reason: "paid_calls_24h_hard_ceiling" },
      decision: "skip_budget",
    });
    return NextResponse.json({
      ok: true,
      mode: "apply",
      skipped: true,
      reason: "paid_calls_24h_hard_ceiling",
      rentcast_24h: rentcast24h,
      attom_24h: attom24h,
      paid_24h: paid24h,
      ceiling,
      engaged_stale_total: targets.length,
      duration_ms: Date.now() - t0,
    });
  }

  const origin = originFromRequest(req);
  const cookie = cookieHeader;
  const deadlineAtMs = t0 + (Number(maxDuration) * 1000 - 20_000);
  const results: Array<Record<string, unknown>> = [];

  for (const l of targets.slice(0, limit)) {
    if (deadlineAtMs - Date.now() < PER_TARGET_BUDGET_MS) break; // no half-run
    const r = await autoRunOnEngaged({ recordId: l.id, origin, cookie, deadlineAtMs });

    // DECISION PERSIST — success or failure, the record carries the outcome.
    // Re-fetch so the compute reads the ARV/rehab the routes just wrote; on
    // an ARV failure the stale listing yields NEEDS_DATA with the reason —
    // and its stamp drives the selection backoff (no queue starvation).
    let decisionVerdict: string | null = null;
    try {
      const fresh = (await getListing(l.id)) ?? l;
      const d = await persistDecisionMath(fresh, { trigger: "engaged_cron" });
      decisionVerdict = d.result.verdict;
    } catch (err) {
      console.error(`[auto-underwrite-engaged] decision persist failed for ${l.id}:`, err);
    }

    results.push({
      record_id: l.id,
      address: l.address,
      arv: r.arvOk ? "ok" : `failed(${r.arvHttpStatus ?? "?"})`,
      rehab: r.rehab,
      buyer_intel: r.buyerIntel,
      reprice: r.reprice,
      decision: decisionVerdict,
    });
    await audit({
      agent: "appraiser",
      event: "auto_underwrite_engaged",
      status: r.arvOk ? "confirmed_success" : "confirmed_failure",
      recordId: l.id,
      inputSummary: { address: l.address, status: l.outreachStatus, source_version: l.sourceVersion, trigger: "engaged_stale_cron" },
      outputSummary: { arv_ok: r.arvOk, rehab: r.rehab, buyer_intel: r.buyerIntel, reprice: r.reprice, your_mao: r.repriceYourMao, decision: decisionVerdict },
      decision: "auto_underwrite",
    });
  }

  return NextResponse.json({
    ok: true,
    mode: "apply",
    auth_kind: authKind,
    engaged_stale_total: targets.length,
    rentcast_24h: rentcast24h,
    attempted: results.length,
    arv_ok: results.filter((r) => r.arv === "ok").length,
    results,
    duration_ms: Date.now() - t0,
  });
}
