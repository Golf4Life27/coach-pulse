// Decision-math backfill/reconcile cron (decision-math build, 2026-07-13).
// @agent: appraiser
//
// Sweeps every ACTIVE-LANE record and persists the decision set (Buyer_
// Ceiling / Deal_Spread / AllIn_Pct_ARV / Decision_Verdict / reason /
// confidence) from STORED fields — zero paid calls. Where the underwrite
// exists the record comes out with full math; where it doesn't the record
// comes out with an explicit NEEDS_DATA + what's missing. After this cron's
// first pass, no active-lane record shows an opener with nothing behind it —
// the gap is at least NAMED on the record (and the engaged cron / backfill
// routes own filling it).
//
// Hash-gated per record (±$5 tolerance) — unchanged inputs are a no-op, so
// the recurring schedule reconciles cheaply instead of churning Airtable.
//
// GET  ?dry=1 (default)  count the cohort + preview, write nothing.
//      ?apply=1          compute + persist for up to `limit` records.
//      ?limit=N          default 60, max 200 (pure compute, ~2 writes/s).

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
import { persistDecisionMath } from "@/lib/decision-persist";
import { ENGAGED_STATUSES } from "@/lib/appraiser/engaged-underwrite-select";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

/** Active lanes (brief Part B3): anything the operator might act on. */
const ACTIVE_LANES: ReadonlySet<string> = new Set([
  ...ENGAGED_STATUSES,
  "Texted",
  "Emailed",
  "Parked",
  "Multi-Listing Queued",
]);

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

  let all: Listing[];
  try {
    all = await getListings();
  } catch (err) {
    return NextResponse.json({ error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Engaged first (live money), then newest activity — bounded runs cover
  // the hottest records before the long tail.
  const cohort = all
    .filter((l) => ACTIVE_LANES.has(l.outreachStatus ?? ""))
    .sort((a, b) => {
      const ae = ENGAGED_STATUSES.has(a.outreachStatus ?? "") ? 0 : 1;
      const be = ENGAGED_STATUSES.has(b.outreachStatus ?? "") ? 0 : 1;
      if (ae !== be) return ae - be;
      const at = a.lastInboundAt ?? a.lastOutboundAt ?? null;
      const bt = b.lastInboundAt ?? b.lastOutboundAt ?? null;
      return (bt ? Date.parse(bt) : 0) - (at ? Date.parse(at) : 0);
    });

  if (!apply) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      auth_kind: authKind,
      active_lane_total: cohort.length,
      would_process: Math.min(limit, cohort.length),
      duration_ms: Date.now() - t0,
    });
  }

  const deadlineAtMs = t0 + maxDuration * 1000 - 10_000;
  let written = 0;
  let unchanged = 0;
  let errors = 0;
  const byVerdict: Record<string, number> = {};

  for (const l of cohort.slice(0, limit)) {
    if (Date.now() > deadlineAtMs) break;
    try {
      const d = await persistDecisionMath(l, { trigger: "backfill" });
      byVerdict[d.result.verdict] = (byVerdict[d.result.verdict] ?? 0) + 1;
      if (d.skippedUnchanged) unchanged++;
      else if (d.written) written++;
      else errors++;
    } catch (err) {
      errors++;
      console.error(`[decision-backfill] ${l.id}:`, err);
    }
  }

  const summary = {
    active_lane_total: cohort.length,
    processed: written + unchanged + errors,
    written,
    unchanged_noop: unchanged,
    errors,
    by_verdict: byVerdict,
    duration_ms: Date.now() - t0,
  };
  await audit({
    agent: "appraiser",
    event: "decision_backfill_sweep",
    status: errors === 0 ? "confirmed_success" : "uncertain",
    inputSummary: { limit, auth_kind: authKind },
    outputSummary: summary,
  });
  return NextResponse.json({ ok: true, mode: "apply", auth_kind: authKind, ...summary });
}
