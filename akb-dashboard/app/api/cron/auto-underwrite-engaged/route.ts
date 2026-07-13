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
// raw intake), freshness dedupe (skip records priced <14d ago), and the
// paid-API burn-rate guard (resolveSeedBudget — skip the whole run when the
// 24h paid-call budget is spent; per-deal runaway is enforced downstream by
// the RentCast loop-breaker). Bounded per run.
//
// GET  ?dry=1 (default)  list the cohort, spend nothing.
//      ?apply=1          compute for up to `limit` targets.
//      ?limit=N          cap (default 4, max 10) — vision is 1-3 min each.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { resolveSeedBudget } from "@/lib/spend/daily-budget";
import { selectEngagedUnderwriteTargets } from "@/lib/appraiser/engaged-underwrite-select";
import { autoRunOnEngaged, originFromRequest } from "@/lib/appraiser/auto-run-on-engaged";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 10;
const PER_TARGET_BUDGET_MS = 200_000; // ARV + vision rehab + buyer-intel

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

  // Paid-API burn-rate guard — skip the whole run when the 24h budget is spent.
  const budget = await resolveSeedBudget(now).catch(() => null);
  if (budget && budget.remainingUsd <= 0) {
    await audit({
      agent: "appraiser",
      event: "auto_underwrite_engaged_budget_skip",
      status: "confirmed_success",
      inputSummary: { engaged_stale_total: targets.length, remaining_usd: budget.remainingUsd },
      outputSummary: { skipped: true, reason: "daily_paid_budget_exhausted" },
      decision: "skip_budget",
    });
    return NextResponse.json({
      ok: true,
      mode: "apply",
      skipped: true,
      reason: "daily_paid_budget_exhausted",
      remaining_usd: budget.remainingUsd,
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
    results.push({
      record_id: l.id,
      address: l.address,
      arv: r.arvOk ? "ok" : `failed(${r.arvHttpStatus ?? "?"})`,
      rehab: r.rehab,
      buyer_intel: r.buyerIntel,
      reprice: r.reprice,
    });
    await audit({
      agent: "appraiser",
      event: "auto_underwrite_engaged",
      status: r.arvOk ? "confirmed_success" : "confirmed_failure",
      recordId: l.id,
      inputSummary: { address: l.address, status: l.outreachStatus, source_version: l.sourceVersion, trigger: "engaged_stale_cron" },
      outputSummary: { arv_ok: r.arvOk, rehab: r.rehab, buyer_intel: r.buyerIntel, reprice: r.reprice, your_mao: r.repriceYourMao },
      decision: "auto_underwrite",
    });
  }

  return NextResponse.json({
    ok: true,
    mode: "apply",
    auth_kind: authKind,
    engaged_stale_total: targets.length,
    attempted: results.length,
    arv_ok: results.filter((r) => r.arv === "ok").length,
    results,
    duration_ms: Date.now() - t0,
  });
}
