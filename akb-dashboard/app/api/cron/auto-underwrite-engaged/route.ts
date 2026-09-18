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
// retry backoff (a failed attempt doesn't starve the queue), and an
// ENGAGED-LANE ATTOM 24h ceiling (per-shape runaway is enforced downstream
// by the paid-call loop-breaker). Bounded per run.
//
// BUDGET-GATE FIX (2026-07-13 decision-math build): this run was originally
// gated on resolveSeedBudget — the $25/day FRONTIER-SEEDING throttle — which
// the */5 appraiser-backfill + seed sweeps exhaust every day, so the engaged
// lane never processed a single target (14:25Z run: 200 OK, zero sub-calls;
// Mayfield/716 8th/Bennett all blank). Engaged deals are the MONEY lane —
// the reply justified the spend (2026-06-10 ruling) — and an engaged
// underwrite is not a seed. The gate became a hard 24h SHARED paid-call
// ceiling (RentCast + ATTOM together, from lib/rentcast/spend-ceiling).
//
// STARVATION FIX (2026-09-18, the Harrison St / Ocala class): the shared
// ceiling counted the DISCOVERY-SWEEP lane's ~340 RentCast calls/day against
// this lane's budget, so the whole run skipped every single day — two live
// counters landed with zero ARV/rehab because this cron never even started.
// The gate is now an ENGAGED-LANE-ONLY ceiling on ATTOM calls in the last
// 24h (counts.attom — comp billing moved to ATTOM 2026-07-20, and ATTOM is
// what this lane actually spends on per-target). RentCast's own 24h/day
// caps (lib/rentcast/spend-ceiling) still apply to any RentCast call this
// lane makes via the choke point — this is an ADDITIONAL, narrower guard
// scoped to the money lane's own spend, not a shared budget another lane
// can exhaust. rentcast_24h is still read and reported for visibility.
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

/** ENGAGED-LANE ATTOM 24h ceiling (2026-09-18 starvation fix). Counts ONLY
 *  this lane's own ATTOM comp calls in the last 24h — never the shared
 *  RentCast+ATTOM meter another lane (discovery-sweep: ~340 RentCast
 *  calls/day) can fill up on its own. Default 60 — comfortably above the
 *  worst-case per-run spend (limit × ~5 ATTOM calls) across every scheduled
 *  slot in a day, while still catching a genuine per-shape runaway (the
 *  paid-call loop-breaker is the other, per-record guard on that). Env:
 *  ENGAGED_LANE_ATTOM_24H_CAP. */
export function engagedLaneAttom24hCap(): number {
  const raw = Number(process.env.ENGAGED_LANE_ATTOM_24H_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60;
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

  // ENGAGED-LANE ATTOM 24h ceiling — this lane's OWN whole-run guard (see
  // the 2026-09-18 STARVATION FIX header note). Gates on attom24h alone, not
  // the shared paid_24h total another lane's RentCast spend can fill up on
  // its own. rentcast_24h is still read and reported for operator
  // visibility, never as a gating input. Fail-open on an unreadable meter:
  // this lane is bounded (limit × ~5 calls) and the loop-breaker guards
  // per-shape runaway on both vendors, so a monitoring outage must not
  // stall live deals.
  const ceiling = engagedLaneAttom24hCap();
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
    attom24h = null;
    paid24h = null;
  }
  if (attom24h != null && attom24h >= ceiling) {
    await audit({
      agent: "appraiser",
      event: "auto_underwrite_engaged_budget_skip",
      status: "confirmed_success",
      inputSummary: { engaged_stale_total: targets.length, rentcast_24h: rentcast24h, attom_24h: attom24h, paid_24h: paid24h, ceiling },
      outputSummary: { skipped: true, reason: "engaged_lane_attom_24h_cap" },
      decision: "skip_budget",
    });
    return NextResponse.json({
      ok: true,
      mode: "apply",
      skipped: true,
      reason: "engaged_lane_attom_24h_cap",
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
