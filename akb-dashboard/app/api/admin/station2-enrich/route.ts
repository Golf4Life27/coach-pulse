// Station 2 ENRICH — per-record RentCast backfill.
// @agent: scout/appraiser
//
// GET /api/admin/station2-enrich
//   (no params)              — dry-run: count active records missing
//                              Bathrooms or Building_SqFt, estimate the
//                              RentCast call count (~1-2 fetches per
//                              record), return without firing.
//   ?apply=1                 — fire RentCast getSubjectFacts for each
//                              missing-fact record (capped by ?limit,
//                              default 100). Idempotent: records already
//                              populated for both fields are skipped, so
//                              re-firing the route is safe.
//   ?limit=N                 — cap per-invocation calls (default 100).
//   ?confirm_over_threshold=1
//                            — required when the missing-fact population
//                              would project > THRESHOLD calls in a
//                              single apply pass. Forces the operator to
//                              think before burning credits in bulk.
//
// Source attribution: every write emits a station2_enrich audit entry
// with agent="rentcast", inputSummary.enrichment_source=
// ENRICHMENT_SOURCE.RENTCAST_FACTS (the canonical provenance label,
// standardized in lib/conveyor/enrichment-source.ts), and the HTTP
// boundary fires a paid_api_call audit through the wrapped fetch in
// lib/rentcast.ts. Per-deal runaway shows up in Pulse's
// paid_api_spend_24h detector.
//
// Year_Built: NOW WRITTEN (Airtable field fldXf7Xhw5sBqNRWk added
// 2026-06-08). Eligibility includes missing-Year_Built, so a record
// that already has sqft+baths but no year is still picked up — that's
// the path that backfills the cohort enriched before the field existed.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { getSubjectFacts } from "@/lib/rentcast";
import { ENRICHMENT_SOURCE } from "@/lib/conveyor/enrichment-source";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 100;
const THRESHOLD_FOR_CONFIRM = 100;
const WALL_CLOCK_BUDGET_MS = 270_000;

function missingFacts(l: Listing): { missingSqft: boolean; missingBaths: boolean; missingYear: boolean } {
  return {
    missingSqft: !(l.buildingSqFt != null && l.buildingSqFt > 0),
    missingBaths: !(l.bathrooms != null && l.bathrooms > 0),
    missingYear: !(l.yearBuilt != null && l.yearBuilt > 0),
  };
}

function needsEnrichment(l: Listing): boolean {
  const m = missingFacts(l);
  return m.missingSqft || m.missingBaths || m.missingYear;
}

interface EnrichWrite {
  recordId: string;
  address: string;
  /** RentCast endpoint that resolved (listings_sale | properties | null). */
  source: string | null;
  wrote: { sqft?: number; baths?: number; yearBuilt?: number };
  error: string | null;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall ───────────────────────────────────────────────
  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
      authKind = auth.kind;
    }
  }

  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const confirmOverThreshold = url.searchParams.get("confirm_over_threshold") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT;

  let active: Listing[];
  try {
    active = await getActiveListingsForBrief();
  } catch (err) {
    return NextResponse.json(
      { error: "active_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // ── Compute the missing-fact population ──────────────────────────
  const eligible = active.filter(needsEnrichment);
  const missingSqftCount = active.filter((l) => missingFacts(l).missingSqft).length;
  const missingBathsCount = active.filter((l) => missingFacts(l).missingBaths).length;
  const missingYearCount = active.filter((l) => missingFacts(l).missingYear).length;

  // getSubjectFacts makes 1 fetch when /listings/sale resolves sqft (the
  // common case for ACTIVE records), 2 when it falls back to /properties.
  // 1.5 is the conservative midpoint for the projected-spend estimate;
  // ACTUAL calls trend toward 1×eligible for active subjects and are
  // recoverable exactly from writes[].source post-run (listings_sale = 1,
  // properties|null = 2). Reconcile against the spend meter's
  // bySource.rentcast counter.
  const projectedCalls = Math.ceil(eligible.length * 1.5);

  const dryRunSummary = {
    active_total: active.length,
    eligible_for_enrich: eligible.length,
    missing_sqft: missingSqftCount,
    missing_baths: missingBathsCount,
    missing_year: missingYearCount,
    projected_rentcast_calls: projectedCalls,
    projected_calls_lower_bound: eligible.length,
    projected_calls_upper_bound: eligible.length * 2,
    threshold_for_confirm: THRESHOLD_FOR_CONFIRM,
    over_threshold: projectedCalls > THRESHOLD_FOR_CONFIRM,
    eligible_records: eligible.map((l) => ({
      recordId: l.id,
      address: l.address,
      missing_sqft: missingFacts(l).missingSqft,
      missing_baths: missingFacts(l).missingBaths,
      missing_year: missingFacts(l).missingYear,
    })),
  };

  // ── Dry run / threshold guard ────────────────────────────────────
  if (!apply) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      auth_kind: authKind,
      summary: dryRunSummary,
      duration_ms: Date.now() - t0,
    });
  }

  if (projectedCalls > THRESHOLD_FOR_CONFIRM && !confirmOverThreshold) {
    return NextResponse.json(
      {
        ok: false,
        mode: "apply_blocked",
        reason: "over_threshold_without_confirm",
        message: `Projected ${projectedCalls} RentCast calls > threshold ${THRESHOLD_FOR_CONFIRM}. Re-fire with ?confirm_over_threshold=1 to override, or run a bounded pass with ?limit=N.`,
        summary: dryRunSummary,
      },
      { status: 409 },
    );
  }

  // ── Apply mode ───────────────────────────────────────────────────
  const writes: EnrichWrite[] = [];
  for (const l of eligible.slice(0, limit)) {
    if (Date.now() - t0 > WALL_CLOCK_BUDGET_MS) break;
    if (!l.city || !l.state || !l.zip) {
      writes.push({
        recordId: l.id,
        address: l.address,
        source: null,
        wrote: {},
        error: "address_parts_missing",
      });
      continue;
    }
    const t1 = Date.now();
    try {
      const facts = await getSubjectFacts({
        address: l.address,
        city: l.city,
        state: l.state,
        zip: l.zip,
      });
      const m = missingFacts(l);
      const fieldsToWrite: Record<string, number> = {};
      const wrote: EnrichWrite["wrote"] = {};
      if (m.missingSqft && facts.squareFootage != null) {
        fieldsToWrite["Building_SqFt"] = facts.squareFootage;
        wrote.sqft = facts.squareFootage;
      }
      if (m.missingBaths && facts.bathrooms != null) {
        fieldsToWrite["Bathrooms"] = facts.bathrooms;
        wrote.baths = facts.bathrooms;
      }
      if (m.missingYear && facts.yearBuilt != null) {
        fieldsToWrite["Year_Built"] = facts.yearBuilt;
        wrote.yearBuilt = facts.yearBuilt;
      }
      if (Object.keys(fieldsToWrite).length > 0) {
        await updateListingRecord(l.id, fieldsToWrite);
      }
      writes.push({
        recordId: l.id,
        address: l.address,
        source: facts.source,
        wrote,
        error: Object.keys(fieldsToWrite).length === 0 ? "rentcast_no_facts" : null,
      });
      await audit({
        agent: "rentcast",
        event: "station2_enrich",
        status: Object.keys(fieldsToWrite).length > 0 ? "confirmed_success" : "uncertain",
        recordId: l.id,
        ms: Date.now() - t1,
        inputSummary: {
          enrichment_source: ENRICHMENT_SOURCE.RENTCAST_FACTS,
          address: l.address,
          missing: m,
        },
        outputSummary: {
          rentcast_endpoint: facts.source,
          wrote,
          year_built_seen: facts.yearBuilt,
        },
        decision: Object.keys(fieldsToWrite).length > 0 ? "enriched" : "no_facts",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writes.push({
        recordId: l.id,
        address: l.address,
        source: null,
        wrote: {},
        error: msg.slice(0, 200),
      });
      await audit({
        agent: "rentcast",
        event: "station2_enrich",
        status: "confirmed_failure",
        recordId: l.id,
        ms: Date.now() - t1,
        inputSummary: { enrichment_source: ENRICHMENT_SOURCE.RENTCAST_FACTS, address: l.address },
        error: msg.slice(0, 200),
      });
    }
  }

  const sqftWritten = writes.filter((w) => w.wrote.sqft != null).length;
  const bathsWritten = writes.filter((w) => w.wrote.baths != null).length;
  const yearBuiltWritten = writes.filter((w) => w.wrote.yearBuilt != null).length;
  // Exact RentCast call count from the per-record source: listings_sale
  // resolved on the first call (1); properties|null fell back (2).
  const actualRentcastCalls = writes
    .filter((w) => w.error !== "address_parts_missing")
    .reduce((n, w) => n + (w.source === "listings_sale" ? 1 : 2), 0);

  return NextResponse.json({
    ok: true,
    mode: "apply",
    auth_kind: authKind,
    summary: dryRunSummary,
    apply: {
      attempted: writes.length,
      sqft_written: sqftWritten,
      baths_written: bathsWritten,
      year_built_written: yearBuiltWritten,
      // Reconciliation: projected (summary.projected_rentcast_calls) vs the
      // exact count derived from per-record source. Compare actual against
      // the spend meter's bySource.rentcast delta over the same window.
      actual_rentcast_calls: actualRentcastCalls,
      projected_rentcast_calls: dryRunSummary.projected_rentcast_calls,
      enrichment_source: ENRICHMENT_SOURCE.RENTCAST_FACTS,
      writes,
    },
    duration_ms: Date.now() - t0,
  });
}
