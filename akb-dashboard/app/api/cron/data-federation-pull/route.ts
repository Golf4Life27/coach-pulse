// INV-022 Sprint 3 — Data Source Federation cron.
// @agent: data_federation
//
// GET /api/cron/data-federation-pull
//
// Daily 16:00 UTC. Scans Listings_V1 for DD-stage-and-later records
// (Outreach_Status ∈ {Negotiating, Offer Accepted, Contract Signed}) that
// are past their freshness window, and hydrates Property_Intel from the
// three live-API v1 vendors: RentCast (AS-IS value + rent + comps),
// ScraperAPI/Street View (photos), FEMA NFHL (flood zone).
//
// Discipline (per Sprint 3 authorization):
//   - Partial-failure isolation: each vendor in its own try/catch.
//     RentCast failing does NOT block FEMA. Hydration_Status reflects what
//     actually succeeded (complete / partial / failed).
//   - Budget gate at top: if the per-run RentCast credit ceiling can't
//     afford a single hydration, log + abort cleanly (no partial pulls).
//     Per-record budget is decremented; RentCast is skipped (skipped_budget)
//     once exhausted while FEMA/photos (free) continue.
//   - Discrepancy surface via buildDiscrepancyFlags (Sprint 1) — Memphis
//     assignment + price-drift + flood. (Lien/owner flags are v2 / PropStream.)
//   - Static-per-parcel caching: flood zone pulled once, then skipped.
//
// All pulls Type 1 autonomous (Constitution Rule 3). No operator gate.
//
// v1 vendor scope: RentCast + ScraperAPI + FEMA. v2 (separate): PropStream
// liens/owner, InvestorBase Buyer_Median, crime grade, Firecrawl (INV-028).

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
import { shouldHydrate } from "@/lib/maverick/property-intel-hydrate";
import { hydrateValuation, rentcastBudgetAllows } from "@/lib/federation/rentcast-hydrate";
import { hydratePhotos } from "@/lib/federation/scraperapi-hydrate";
import { getFloodZoneByAddress } from "@/lib/fema-flood";
import {
  findPropertyIntelRecordByListing,
  upsertPropertyIntel,
  buildHydrationFields,
} from "@/lib/federation/property-intel-store";
import { hydrateRecord } from "@/lib/federation/federation-orchestration";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Per-run RentCast credit ceiling. Conservative slice of the monthly cap
 *  (RENTCAST_MONTHLY_CAP default 1000) so a single daily run can't exhaust
 *  the month. ~40 credits = ~20 record hydrations/run. Overridable via env. */
const RENTCAST_FEDERATION_PER_RUN_CREDITS = Number(
  process.env.RENTCAST_FEDERATION_PER_RUN_CREDITS ?? "40",
);

interface FederationSummary {
  scanned: number;
  eligible: number;
  hydrated: number;
  skipped_not_eligible: number;
  skipped_fresh: number;
  status_complete: number;
  status_partial: number;
  status_failed: number;
  rentcast_budget_skips: number;
  errors: Array<{ recordId: string; address: string; error: string }>;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall (mirrors /api/cron/rehab-vision-retry) ───────
  const cookieHeader = req.headers.get("cookie");
  const isDashboard = hasDashboardSession(cookieHeader);
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" =
    "none";
  if (isDashboard) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired =
      kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json(
          { error: "unauthorized", reason: auth.reason },
          { status: 401 },
        );
      }
      authKind = auth.kind;
    }
  }
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  // ── Budget gate at top ──────────────────────────────────────────
  let rentcastBudget = RENTCAST_FEDERATION_PER_RUN_CREDITS;
  const topGate = rentcastBudgetAllows(rentcastBudget);
  if (!topGate.allowed) {
    await audit({
      agent: "appraiser",
      event: "data_federation_budget_exhausted_at_start",
      status: "uncertain",
      inputSummary: { auth_kind: authKind, per_run_credits: rentcastBudget },
      outputSummary: { duration_ms: Date.now() - t0 },
    });
    return NextResponse.json({
      ok: true,
      aborted: "rentcast_budget_exhausted_at_start",
      per_run_credits: rentcastBudget,
      auth_kind: authKind,
      duration_ms: Date.now() - t0,
    });
  }

  const summary: FederationSummary = {
    scanned: 0,
    eligible: 0,
    hydrated: 0,
    skipped_not_eligible: 0,
    skipped_fresh: 0,
    status_complete: 0,
    status_partial: 0,
    status_failed: 0,
    rentcast_budget_skips: 0,
    errors: [],
  };

  let listings;
  try {
    listings = await getListings();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "appraiser",
      event: "data_federation_fetch_failed",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { error: "listings_fetch_failed", message: msg },
      { status: 502 },
    );
  }

  summary.scanned = listings.length;
  const now = new Date();

  for (const l of listings) {
    // ── Existing Property_Intel row (freshness + flood cache) ─────
    let existing: { recordId: string; fields: Record<string, unknown> } | null = null;
    try {
      existing = await findPropertyIntelRecordByListing(l.id);
    } catch (err) {
      summary.errors.push({
        recordId: l.id,
        address: l.address,
        error: `find_existing: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const lastHydratedAt =
      (existing?.fields["Last_Hydrated_At"] as string | undefined) ?? null;

    const decision = shouldHydrate(
      { outreachStatus: l.outreachStatus ?? null, lastHydratedAt },
      now,
    );
    if (decision.action === "skip") {
      if (decision.reason === "status_not_eligible") summary.skipped_not_eligible++;
      else summary.skipped_fresh++;
      continue;
    }
    summary.eligible++;

    // ── Vendor hydration — partial-failure isolated (DI orchestrator) ──
    const existingZone = (existing?.fields["FEMA_Flood_Zone"] as string | undefined) ?? null;
    const { contribution, outcomes, status, creditsSpent } = await hydrateRecord(
      {
        address: l.address,
        city: l.city,
        state: l.state,
        zip: l.zip,
        bedrooms: l.bedrooms,
        bathrooms: l.bathrooms,
        buildingSqFt: l.buildingSqFt,
        verificationUrl: l.verificationUrl ?? null,
        contractOfferPrice: l.contractOfferPrice ?? null,
        existingFloodZone: existingZone,
        rentcastBudgetRemaining: rentcastBudget,
      },
      { hydrateValuation, hydratePhotos, getFloodZoneByAddress },
      now,
    );
    rentcastBudget -= creditsSpent;
    if (outcomes.rentcast === "skipped_budget") summary.rentcast_budget_skips++;

    if (status === "complete") summary.status_complete++;
    else if (status === "partial") summary.status_partial++;
    else summary.status_failed++;

    const fields = buildHydrationFields(contribution);
    try {
      await upsertPropertyIntel(l.id, l.address, fields);
      summary.hydrated++;
    } catch (err) {
      summary.errors.push({
        recordId: l.id,
        address: l.address,
        error: `upsert: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    await audit({
      agent: "appraiser",
      event: "data_federation_hydrated",
      status: status === "failed" ? "confirmed_failure" : "confirmed_success",
      inputSummary: { record_id: l.id, address: l.address, auth_kind: authKind },
      outputSummary: {
        hydration_status: status,
        rentcast: outcomes.rentcast,
        photos: outcomes.photos,
        flood: outcomes.flood,
        discrepancy_severity: contribution.discrepancy?.severityMax ?? "none",
        rentcast_budget_remaining: rentcastBudget,
      },
      decision: status,
      recordId: l.id,
    });
  }

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
    rentcast_budget_remaining: rentcastBudget,
    ...summary,
  });
}
