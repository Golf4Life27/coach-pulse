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
// with agent="rentcast", inputSummary.source="rentcast_facts", and the
// HTTP boundary fires a paid_api_call audit through the wrapped fetch
// in lib/rentcast.ts. Per-deal runaway thus shows up in Pulse's
// paid_api_spend_24h detector immediately.
//
// Year_Built: extracted from getSubjectFacts for the report (so the
// operator can see what would be unlocked) but NOT written — the
// Airtable schema doesn't carry a Year_Built field yet (the Listing
// type carries no yearBuilt slot). Adding that column is a separate
// operator action.
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
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 100;
const THRESHOLD_FOR_CONFIRM = 100;
const WALL_CLOCK_BUDGET_MS = 270_000;

function missingFacts(l: Listing): { missingSqft: boolean; missingBaths: boolean } {
  return {
    missingSqft: !(l.buildingSqFt != null && l.buildingSqFt > 0),
    missingBaths: !(l.bathrooms != null && l.bathrooms > 0),
  };
}

function needsEnrichment(l: Listing): boolean {
  const m = missingFacts(l);
  return m.missingSqft || m.missingBaths;
}

interface EnrichWrite {
  recordId: string;
  address: string;
  source: string | null;
  wrote: { sqft?: number; baths?: number };
  yearBuiltSeen: number | null;
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

  // getSubjectFacts makes 1-2 fetches (listings_sale first, /properties
  // fallback when the active path returns null). 1.5 is the empirical
  // average we use for the projected-spend estimate.
  const projectedCalls = Math.ceil(eligible.length * 1.5);

  const dryRunSummary = {
    active_total: active.length,
    eligible_for_enrich: eligible.length,
    missing_sqft: missingSqftCount,
    missing_baths: missingBathsCount,
    projected_rentcast_calls: projectedCalls,
    threshold_for_confirm: THRESHOLD_FOR_CONFIRM,
    over_threshold: projectedCalls > THRESHOLD_FOR_CONFIRM,
    eligible_records: eligible.map((l) => ({
      recordId: l.id,
      address: l.address,
      missing_sqft: missingFacts(l).missingSqft,
      missing_baths: missingFacts(l).missingBaths,
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
        yearBuiltSeen: null,
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
      if (Object.keys(fieldsToWrite).length > 0) {
        await updateListingRecord(l.id, fieldsToWrite);
      }
      writes.push({
        recordId: l.id,
        address: l.address,
        source: facts.source,
        wrote,
        yearBuiltSeen: facts.yearBuilt,
        error: Object.keys(fieldsToWrite).length === 0 ? "rentcast_no_facts" : null,
      });
      await audit({
        agent: "rentcast",
        event: "station2_enrich",
        status: Object.keys(fieldsToWrite).length > 0 ? "confirmed_success" : "uncertain",
        recordId: l.id,
        ms: Date.now() - t1,
        inputSummary: {
          source: "rentcast_facts",
          address: l.address,
          missing: m,
        },
        outputSummary: {
          rentcast_source: facts.source,
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
        yearBuiltSeen: null,
        error: msg.slice(0, 200),
      });
      await audit({
        agent: "rentcast",
        event: "station2_enrich",
        status: "confirmed_failure",
        recordId: l.id,
        ms: Date.now() - t1,
        inputSummary: { source: "rentcast_facts", address: l.address },
        error: msg.slice(0, 200),
      });
    }
  }

  const sqftWritten = writes.filter((w) => w.wrote.sqft != null).length;
  const bathsWritten = writes.filter((w) => w.wrote.baths != null).length;
  const yearBuiltAvailable = writes.filter((w) => w.yearBuiltSeen != null).length;

  return NextResponse.json({
    ok: true,
    mode: "apply",
    auth_kind: authKind,
    summary: dryRunSummary,
    apply: {
      attempted: writes.length,
      sqft_written: sqftWritten,
      baths_written: bathsWritten,
      year_built_seen_but_not_written: yearBuiltAvailable,
      writes,
    },
    duration_ms: Date.now() - t0,
  });
}
