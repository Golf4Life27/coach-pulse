// Phase 4C.1 — Buyer Intelligence Dual-Track endpoint.
// @agent: appraiser
//
// GET /api/agents/appraiser/buyer-intelligence/[recordId]
//   ?skip_write=1   compute only, don't write Airtable
//   ?force_rent=1   bypass cached Estimated_Monthly_Rent and re-pull
//                   from RentCast even when the listing already has a
//                   value (default: use cached when present)
//
// Pipeline:
//   1. Read listing (incl. realArvMedian, estRehabMid, wholesaleFeeTarget,
//      estimatedMonthlyRent, state)
//   2. If listing.estimatedMonthlyRent is missing OR ?force_rent=1,
//      call RentCast /v1/avm/rent (lib/rentcast.getRentEstimate) and
//      write Estimated_Monthly_Rent back to Airtable.
//   3. Pick calibrated rehab (Phase 4B.1 / J.3 — estRehabMid > estRehab).
//   4. computeDualTrack — both tracks + dominant_track + dominant_value.
//   5. Return { flipper_mao, landlord_mao, dominant_track,
//      dominant_value, modifier_inputs, rent_source, audit }.
//
// Auth + cron gate identical to Phase 4A.1 + 4B.1 endpoints.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { getRentEstimate } from "@/lib/rentcast";
import { computeDualTrack } from "@/lib/appraiser/buyer-intelligence";
import { pickCalibratedRehab } from "@/lib/appraiser/mao-range";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const t0 = Date.now();
  const { recordId } = await params;
  const url = new URL(req.url);
  const skipWrite = url.searchParams.get("skip_write") === "1";
  const forceRent = url.searchParams.get("force_rent") === "1";

  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "invalid_record_id" }, { status: 400 });
  }

  // ── Auth ────────────────────────────────────────────────────────
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

  // ── Load listing ────────────────────────────────────────────────
  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json(
      { error: "listing_not_found", recordId },
      { status: 404 },
    );
  }
  if (!listing.address || !listing.city || !listing.state || !listing.zip) {
    return NextResponse.json(
      {
        error: "missing_address_parts",
        reason: "address + city + state + zip all required for RentCast rent lookup",
        recordId,
      },
      { status: 422 },
    );
  }

  // ── Rent — cached or pulled ─────────────────────────────────────
  // Source semantics surfaced in audit + response so future Pulse can
  // tell when MAOs are computed from stale rent.
  let monthlyRent: number | null = listing.estimatedMonthlyRent ?? null;
  let rentSource: "cached" | "rentcast_fresh" | "rentcast_failed" | "missing" = "missing";
  let rentError: string | null = null;

  if (monthlyRent != null && !forceRent) {
    rentSource = "cached";
  } else if (process.env.RENTCAST_API_KEY) {
    try {
      const rentEst = await getRentEstimate({
        address: listing.address,
        city: listing.city,
        state: listing.state,
        zip: listing.zip,
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        squareFootage: listing.buildingSqFt,
      });
      if (rentEst.rent != null && rentEst.rent > 0) {
        monthlyRent = Math.round(rentEst.rent);
        rentSource = "rentcast_fresh";
        // Write Estimated_Monthly_Rent back to Airtable. Skippable via
        // ?skip_write=1; failures audited but never block the dual-track
        // computation.
        if (!skipWrite) {
          try {
            await updateListingRecord(recordId, {
              Estimated_Monthly_Rent: monthlyRent,
            });
          } catch (err) {
            rentError = `airtable_write_failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      } else {
        rentSource = "rentcast_failed";
        rentError = "RentCast returned null/zero rent";
      }
    } catch (err) {
      rentSource = "rentcast_failed";
      rentError = err instanceof Error ? err.message : String(err);
    }
  } else {
    rentError = "RENTCAST_API_KEY not configured — landlord track skipped";
  }

  // ── Pick calibrated rehab (Phase 4B.1 / J.3) ───────────────────
  const rehabPick = pickCalibratedRehab({
    estRehabMid: listing.estRehabMid,
    estRehab: listing.estRehab,
  });

  // ── Dual-track computation ──────────────────────────────────────
  const result = computeDualTrack({
    arvMid: listing.realArvMedian ?? null,
    estRehab: rehabPick.value,
    wholesaleFee: listing.wholesaleFeeTarget ?? null,
    monthlyRent,
    state: listing.state,
  });

  // ── Audit ───────────────────────────────────────────────────────
  await audit({
    agent: "appraiser",
    event: "dual_track_computed",
    status: rentError && rentSource === "rentcast_failed" ? "uncertain" : "confirmed_success",
    inputSummary: {
      record_id: recordId,
      auth_kind: authKind,
      rent_source: rentSource,
      rent_value: monthlyRent,
      rehab_source: rehabPick.source,
      arv_present: result.modifier_inputs.arv_mid != null,
    },
    outputSummary: {
      flipper_mao: result.flipper_mao,
      landlord_mao: result.landlord_mao,
      dominant_track: result.dominant_track,
      dominant_value: result.dominant_value,
      cap_rate: result.modifier_inputs.cap_rate,
      cap_rate_tier: result.modifier_inputs.cap_rate_tier,
      rent_error: rentError,
      airtable_write: !skipWrite && rentSource === "rentcast_fresh",
      duration_ms: Date.now() - t0,
    },
    decision: result.dominant_track,
    recordId,
  });

  return NextResponse.json({
    record_id: recordId,
    address: listing.address,
    city: listing.city,
    state: listing.state,
    zip: listing.zip,
    flipper_mao: result.flipper_mao,
    landlord_mao: result.landlord_mao,
    dominant_track: result.dominant_track,
    dominant_value: result.dominant_value,
    modifier_inputs: result.modifier_inputs,
    rent: {
      monthly_rent: monthlyRent,
      source: rentSource,
      error: rentError,
    },
    rehab: {
      value: rehabPick.value,
      source: rehabPick.source,
    },
    audit: {
      computed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
    },
  });
}
