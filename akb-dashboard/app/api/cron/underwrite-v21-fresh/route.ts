// V21 writer on fresh records (keystone 2026-06-13, spine recmgjlZSwhECn1W0).
// @agent: appraiser
//
// THE PRECISE CONTRACT lane writer. Solves the population-timing problem
// the field census exposed: Your_MAO_V21 / Investor_MAO_V21 are 0% on the
// fresh priceable cohort because their only existing writer
// (stale-deal-triage) fires on >14d-stale records. This cron fires the
// SAME V2.1 landlord math (lib/landlord-hydrate.computeV21LandlordMao —
// no parallel build) on FRESH records at the right funnel stage.
//
// Maverick rulings baked in:
//   FLAG 1 — landlord-only-on-distress. A flipper-track record (no
//     distress) HOLDs; it never borrows the landlord NOI/cap lane.
//     Decision in lib/v21-writer-decision.decideV21Write.
//   FLAG 2 — this writes the PRECISE CONTRACT number ONLY. It does NOT
//     touch the opener. The opener caps on the rough ceiling (separate).
//   WRITER-TRIGGER — operator approved a dedicated */10 cron (this) over
//     piggybacking appraiser-backfill, because that route is pure HTTP
//     orchestration and inlining landlord math there would muddy it.
//
// SAFETY: dry-run by default (report what WOULD write). ?apply=1 writes.
// NOT in vercel.json yet — activation is the next adjudication after
// Maverick eyeballs a dry-run. Idempotent (decideV21Write skips records
// that already carry Your_MAO_V21). Paid RentCast calls mirror
// stale-deal-triage exactly (rent estimate + tax resolution), paced and
// breaker-governed by the same shared helpers.
//
// GET /api/cron/underwrite-v21-fresh
//   ?apply=1     write Your_MAO_V21 / Investor_MAO_V21 / Track (default: dry-run)
//   ?limit=N     cap records per run (default 8)
//   ?zips=a,b    scope to ZIPs (default: all priceable seeded)

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { getListings } from "@/lib/airtable";
import { underwriteV21Record } from "@/lib/v21-underwrite-record";
import { decideV21Write } from "@/lib/v21-writer-decision";
import { getMarketForListing } from "@/lib/markets/registry";
import { listSeededZips } from "@/lib/buyer-median-store";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 8;
const BUDGET_MS = 240_000;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);

  // Auth waterfall (same as every guarded cron).
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
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const apply = url.searchParams.get("apply") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT;
  const zipScope = new Set(
    (url.searchParams.get("zips") ?? "").split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z)),
  );

  // ── WATCHED-FIRST-RUN GATE (Maverick recbAn1F9yOgIfcit, "then stop") ──
  // A cron-auth applied run can only fire ONCE until Maverick clears the
  // KV flag. Subsequent cron-auth applies return 503 with explicit reason.
  // Dashboard/manual runs bypass — Alex can re-fire without consuming the
  // budget. The flag is set AFTER the first cron-auth applied run completes
  // successfully (whether 0 or N records written), so the route fires once,
  // we audit + report, and the second tick stays dark until uncap is
  // committed (env clear or KV del). Fails-OPEN on KV miss because the
  // outer per-run limit already provides a small reviewable batch — if KV
  // is unreachable we degrade to "small batches forever" rather than to
  // "writes everything." Safer side of the trade.
  const WATCHED_FLAG_KEY = "v21_writer:watched_first_run_done";
  const watchedBypass = process.env.V21_WRITER_UNCAPPED === "true";
  if (apply && authKind === "cron" && !watchedBypass && kvConfigured()) {
    try {
      const flag = await kvProd.get(WATCHED_FLAG_KEY);
      if (flag) {
        return NextResponse.json({
          mode: "blocked",
          reason: "watched_first_run_complete_awaiting_uncap_decision",
          detail:
            "the watched first run already completed; subsequent cron-auth applied runs are blocked until Maverick reviews the batch and authorizes uncap " +
            "(set env V21_WRITER_UNCAPPED=true OR del KV key " + WATCHED_FLAG_KEY + "). " +
            "Manual dashboard/operator runs bypass this gate.",
          flag_set_at: flag,
        }, { status: 503 });
      }
    } catch {
      // Fail OPEN — the per-run limit is still the small reviewable batch.
    }
  }

  let listings: Listing[];
  let seededZips: Set<string>;
  try {
    [listings, seededZips] = await Promise.all([getListings(), listSeededZips()]);
  } catch (err) {
    return NextResponse.json({ error: "fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Candidate selection — pure decision per record.
  const candidates: Array<{ l: Listing; lane: "landlord" | "landlord_provisional" }> = [];
  const skipBreakdown: Record<string, number> = {};
  const laneCount = { landlord: 0, landlord_provisional: 0 };
  for (const l of listings) {
    const zip = (l.zip ?? "").trim();
    if (zipScope.size > 0 && !zipScope.has(zip)) continue;
    const market = getMarketForListing({ state: l.state, zip: l.zip });
    const priceable = market?.buyer_params?.arv_pct_max != null && seededZips.has(zip);
    const d = decideV21Write(
      { liveStatus: l.liveStatus, yourMao: l.yourMao, state: l.state, zip: l.zip, redFlags: l.redFlags, distressBucket: l.distressBucket, distressScore: l.distressScore },
      { priceable },
    );
    if (d.write) {
      candidates.push({ l, lane: d.lane });
      laneCount[d.lane]++;
    } else {
      skipBreakdown[d.reason] = (skipBreakdown[d.reason] ?? 0) + 1;
    }
  }

  const batch = candidates.slice(0, limit);
  const results: Array<Record<string, unknown>> = [];
  let written = 0;

  for (const { l, lane } of batch) {
    if (Date.now() - t0 > BUDGET_MS) break;

    // INITIAL underwrite — delegate to the shared per-record writer
    // (single source of truth, also used by the reply-triggered re-price
    // path). allowReprice stays OFF here: this cron fires once per cold
    // priceable record, the idempotency guard holds. forceFreshRent OFF:
    // a cold record's stored rent is fine, don't pay to refetch.
    const outcome = await underwriteV21Record(l, { apply, seededZips });
    const v21 = outcome.result;

    const row = {
      recordId: l.id, address: l.address, zip: l.zip, lane,
      status: v21?.status ?? "skip", your_mao_v21: v21?.yourMao ?? null, investor_mao_v21: v21?.investorMao ?? null,
      cap: v21?.cap ?? null, rent: outcome.monthlyRent, taxes: outcome.taxes, tax_source: outcome.taxSource,
      reason: v21?.reason ?? (outcome.decision.write === false ? outcome.decision.reason : ""),
      // A-prime: a provisional V21 is WRITTEN but flagged; it cannot
      // authorize a contract until DD corroborates (evaluateV21Contract
      // Authorization is the enforcement point).
      provisional: lane === "landlord_provisional",
      authorizes_contract_now: lane === "landlord" && v21?.status === "ok",
      ...(outcome.writeError ? { write_error: outcome.writeError } : {}),
    };
    results.push(row);
    if (outcome.written) written++;
  }

  await audit({
    agent: "appraiser",
    event: apply ? "underwrite_v21_fresh_applied" : "underwrite_v21_fresh_dry_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, apply, limit, zips: [...zipScope] },
    outputSummary: { candidate_total: candidates.length, lane_count: laneCount, examined: batch.length, written, skip_breakdown: skipBreakdown },
    ms: Date.now() - t0,
  });

  // Set the watched-first-run flag AFTER a cron-auth applied run completes.
  // Subsequent cron-auth applies block until Maverick clears the flag (env
  // V21_WRITER_UNCAPPED=true or KV del). 7-day TTL is a safety net — if no
  // one acts in a week the gate clears itself so the cron isn't permanently
  // wedged on an abandoned watch.
  if (apply && authKind === "cron" && !watchedBypass && kvConfigured()) {
    try {
      await kvProd.setEx(WATCHED_FLAG_KEY, new Date().toISOString(), 7 * 24 * 3600);
    } catch {
      /* fail open — guard is best-effort */
    }
  }

  return NextResponse.json({
    mode: apply ? "apply" : "dry_run",
    candidate_total: candidates.length,
    lane_count: laneCount,
    examined: batch.length,
    written,
    skip_breakdown: skipBreakdown,
    results,
    note:
      "NOT scheduled in vercel.json — activation pending Maverick dry-run review. A-prime: " +
      "landlord (scored) authorizes now; landlord_provisional (vision-only redflag) is WRITTEN but " +
      "CANNOT authorize a contract until the DD loop corroborates (lib/v21-contract-authorization).",
    elapsed_ms: Date.now() - t0,
  });
}
