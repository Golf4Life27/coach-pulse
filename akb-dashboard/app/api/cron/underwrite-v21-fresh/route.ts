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
import { getListings, updateListingRecord } from "@/lib/airtable";
import { getRentEstimate, getAnnualPropertyTaxes, getRentCastAssessedValue } from "@/lib/rentcast";
import {
  resolveAnnualTaxes,
  defaultInvestorCapFor,
  computeV21LandlordMao,
  buildMaoV21Marker,
  upsertMaoV21Marker,
  type V21MaoResult,
} from "@/lib/landlord-hydrate";
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

  let listings: Listing[];
  let seededZips: Set<string>;
  try {
    [listings, seededZips] = await Promise.all([getListings(), listSeededZips()]);
  } catch (err) {
    return NextResponse.json({ error: "fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Candidate selection — pure decision per record.
  const candidates: Array<{ l: Listing; priceable: boolean }> = [];
  const skipBreakdown: Record<string, number> = {};
  for (const l of listings) {
    const zip = (l.zip ?? "").trim();
    if (zipScope.size > 0 && !zipScope.has(zip)) continue;
    const market = getMarketForListing({ state: l.state, zip: l.zip });
    const priceable = market?.buyer_params?.arv_pct_max != null && seededZips.has(zip);
    const d = decideV21Write(
      { liveStatus: l.liveStatus, yourMao: l.yourMao, state: l.state, zip: l.zip, redFlags: l.redFlags, distressBucket: l.distressBucket, distressScore: l.distressScore },
      { priceable },
    );
    if (d.write) candidates.push({ l, priceable });
    else skipBreakdown[d.reason] = (skipBreakdown[d.reason] ?? 0) + 1;
  }

  const batch = candidates.slice(0, limit);
  const results: Array<Record<string, unknown>> = [];
  let written = 0;

  for (const { l } of batch) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const addr = { address: l.address ?? "", city: l.city ?? "", state: l.state ?? "", zip: l.zip ?? "" };

    // Rent: stored estimate preferred (free), else a RentCast call.
    let monthlyRent = l.estimatedMonthlyRent ?? null;
    if (monthlyRent == null) {
      const rentEst = await getRentEstimate(addr, l.id).catch(() => null);
      monthlyRent = rentEst?.rent ?? null;
    }
    // Taxes: same resolver precedence stale-deal-triage uses.
    const rcTaxes = await getAnnualPropertyTaxes(addr, l.id).catch(() => null);
    const rcAssessed = await getRentCastAssessedValue(addr, l.id).catch(() => null);
    const taxResolution = resolveAnnualTaxes({
      state: l.state,
      confirmedTaxes: l.confirmedTaxes,
      confirmedLabel: l.confirmedTaxesSource,
      attomTaxes: null,
      attomAssessedValue: null,
      rentcastTaxes: rcTaxes,
      assessedValue: rcAssessed,
    });
    const cap = defaultInvestorCapFor(l.state, l.zip);
    const estRehab = (l.estRehabMid ?? l.estRehab ?? null) as number | null;
    const v21: V21MaoResult = computeV21LandlordMao({
      monthlyRent,
      annualTaxes: taxResolution.annualTaxes,
      estRehab,
      capRate: cap,
    });

    const row = {
      recordId: l.id, address: l.address, zip: l.zip,
      status: v21.status, your_mao_v21: v21.yourMao, investor_mao_v21: v21.investorMao,
      cap: v21.cap, rent: monthlyRent, taxes: taxResolution.annualTaxes, tax_source: taxResolution.source,
      reason: v21.reason,
    };
    results.push(row);

    if (apply && v21.status === "ok" && v21.yourMao != null) {
      const marker = buildMaoV21Marker(
        { status: v21.status, yourMao: v21.yourMao, investorMao: v21.investorMao, cap: v21.cap, rent: monthlyRent, taxes: taxResolution.annualTaxes },
        new Date(),
      );
      try {
        await updateListingRecord(l.id, {
          Your_MAO_V21: v21.yourMao,
          Investor_MAO_V21: v21.investorMao,
          Underwritten_MAO_Track: "landlord",
          Estimated_Monthly_Rent: monthlyRent,
          Verification_Notes: upsertMaoV21Marker(l.notes ?? null, marker),
        });
        written++;
      } catch (err) {
        (row as Record<string, unknown>).write_error = String(err).slice(0, 200);
      }
    }
  }

  await audit({
    agent: "appraiser",
    event: apply ? "underwrite_v21_fresh_applied" : "underwrite_v21_fresh_dry_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, apply, limit, zips: [...zipScope] },
    outputSummary: { candidate_total: candidates.length, examined: batch.length, written, skip_breakdown: skipBreakdown },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: apply ? "apply" : "dry_run",
    candidate_total: candidates.length,
    examined: batch.length,
    written,
    skip_breakdown: skipBreakdown,
    results,
    note: "NOT scheduled in vercel.json — activation pending Maverick dry-run review. FLAG-1: landlord-only-on-distress; flipper records HOLD.",
    elapsed_ms: Date.now() - t0,
  });
}
