// Phase 4A.1 — Appraiser ARV endpoint (record-scoped, persistent).
// @agent: appraiser
//
// GET /api/agents/appraiser/arv/[recordId]
//   ?skip_write=1   compute only, don't write Airtable
//   ?force=1        bypass any caching layer (currently no cache here;
//                   flag preserved for future use)
//
// The standalone ARV calculator per the Phase 4A.1 brief. Differs from
// /api/arv-intelligence/[zip] in two ways: (1) record-scoped — reads
// the listing by recordId, pulls subject facts from Airtable; (2)
// persistent — writes Real_ARV_*, ARV_Confidence, ARV_Comp_Count,
// ARV_Comp_Avg_PrSqFt, ARV_Comp_Details_JSON, ARV_Validated_At to
// Airtable on success. The math is shared with the existing Pricing
// Agent (lib/arv-intelligence.computeArvIntelligence).
//
// Returns the v1.3 MAO range envelope per Phase 20.2 amendment:
//   { arv, confidence, range: { floor, target, list_price, soft_ceiling,
//   exceeds_soft_ceiling, modifier_inputs }, source_comps, audit }
//
// Validation anchor: 1219 E Highland Blvd 78210 → ~$90K MAO end-to-end
// (covered by lib/appraiser/mao-range.test.ts pure helper test).

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { getSaleComparables } from "@/lib/rentcast";
import { computeArvIntelligence } from "@/lib/arv-intelligence";
import {
  classifyArvConfidenceByCount,
  requiresManualReview,
  computeMaoRange,
  pickCalibratedRehab,
} from "@/lib/appraiser/mao-range";
import { getMarketForListing } from "@/lib/markets/registry";
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

  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "invalid_record_id" }, { status: 400 });
  }

  // Auth — dashboard session → OAuth waterfall (same pattern as
  // load-state, recall, track-envelope, send-reminder).
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

  if (!process.env.RENTCAST_API_KEY) {
    return NextResponse.json(
      { error: "rentcast_not_configured" },
      { status: 503 },
    );
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
        reason: "address + city + state + zip all required for RentCast comp lookup",
        recordId,
      },
      { status: 422 },
    );
  }

  // ── RentCast comps ──────────────────────────────────────────────
  let comps;
  try {
    comps = await getSaleComparables({
      address: listing.address,
      city: listing.city,
      state: listing.state,
      zip: listing.zip,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      squareFootage: listing.buildingSqFt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "appraiser",
      event: "arv_rentcast_failed",
      status: "confirmed_failure",
      inputSummary: { record_id: recordId, zip: listing.zip, auth_kind: authKind },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
      recordId,
    });
    return NextResponse.json(
      { error: "rentcast_call_failed", message: msg },
      { status: 502 },
    );
  }

  // ── Run the existing ARV math ───────────────────────────────────
  const arv = computeArvIntelligence(comps, {
    zip: listing.zip,
    beds: listing.bedrooms,
    baths: listing.bathrooms,
    sqft: listing.buildingSqFt,
    // Agent default — offer math targets renovated retail value.
    condition_target: "renovated",
    // Phase 4B not invoked from this endpoint; Detroit/Memphis will
    // fall back to as-is mirror if rehab_mid is absent. Pricing Agent
    // composition (which DOES invoke 4B first) is the path for those
    // markets to get a true renovated value.
    rehab_mid: listing.estRehabMid ?? listing.estRehab ?? null,
  });

  // ── Count-based confidence per Phase 4A.1 spec ──────────────────
  // The internal arv.confidence is informational (cluster quality + market
  // type + filter survival). The dashboard-facing label goes by comp
  // count per the spec: HIGH 5+, MED 3-4, LOW <3 → Manual Review.
  const confidence = classifyArvConfidenceByCount(arv.comp_count_used);
  const manualReview = requiresManualReview(confidence);

  // ── v1.3 MAO range envelope ─────────────────────────────────────
  // Phase 4B.1 / J.3 — prefer Phase 4B.1 calibrated rehab
  // (estRehabMid) over legacy estRehab. Source surfaced in audit so
  // future Pulse can detect MAO floors still computed from legacy data.
  const rehabPick = pickCalibratedRehab({
    estRehabMid: listing.estRehabMid,
    estRehab: listing.estRehab,
  });
  // Resolve the deal's market so the MAO range HOLDs (no resale-minus-rehab
  // floor surfaces) when the market has no sourced buy-box discount — e.g.
  // San Antonio (buyer_params:null). Priceable markets (Detroit 0.6461) pass
  // the discount and compute normally.
  const market = getMarketForListing({ state: listing.state, zip: listing.zip });
  const range = computeMaoRange({
    arvMid: arv.arv_mid,
    estRehab: rehabPick.value,
    wholesaleFee: listing.wholesaleFeeTarget ?? null,
    buyerProfit: listing.buyerProfitTarget ?? null,
    listPrice: listing.listPrice,
    sellerMotivationScore: listing.sellerMotivationScore ?? null,
    // Phase 4C.1 / K.3 — pass rent + state so MAO range uses
    // dual-track dominant_value as the floor when both are present.
    // Falls back to flipper-only floor when rent is null.
    monthlyRent: listing.estimatedMonthlyRent ?? null,
    state: listing.state,
    // Unpriceable-market HOLD gate (sourced-discount requirement).
    arvDiscountPct: market?.buyer_params?.arv_pct_max ?? null,
    requireSourcedDiscount: true,
  });

  // ── Airtable write (skippable) ──────────────────────────────────
  // Same discipline as the Pricing Agent: only write fields with a
  // real computed value. Don't overwrite existing data with null.
  const nowIso = new Date().toISOString();
  let airtableError: string | null = null;
  if (!skipWrite && arv.arv_mid != null) {
    const fieldsToWrite: Record<string, unknown> = {
      Real_ARV_Low: arv.arv_low,
      Real_ARV_High: arv.arv_high,
      Real_ARV_Median: arv.arv_mid,
      ARV_Confidence: confidence,
      ARV_Comp_Count: arv.comp_count_used,
      ARV_Comp_Avg_PrSqFt: arv.avg_per_sqft,
      ARV_Comp_Details_JSON: JSON.stringify(arv.comps_used).slice(0, 95_000),
      ARV_Validated_At: nowIso,
    };
    try {
      await updateListingRecord(recordId, fieldsToWrite);
    } catch (err) {
      airtableError = err instanceof Error ? err.message : String(err);
    }
  }

  // ── Audit ───────────────────────────────────────────────────────
  await audit({
    agent: "appraiser",
    event: "arv_computed",
    status: airtableError ? "uncertain" : "confirmed_success",
    inputSummary: {
      record_id: recordId,
      zip: listing.zip,
      auth_kind: authKind,
      skip_write: skipWrite,
    },
    outputSummary: {
      arv_mid: arv.arv_mid,
      arv_method: arv.arv_method,
      confidence,
      confidence_internal: arv.confidence,
      comp_count_used: arv.comp_count_used,
      comp_count_excluded: arv.comp_count_excluded,
      avg_per_sqft: arv.avg_per_sqft,
      floor: range.floor,
      target: range.target,
      exceeds_soft_ceiling: range.exceeds_soft_ceiling,
      dominant_track: range.dual_track?.dominant_track ?? "flipper",
      flipper_mao: range.dual_track?.flipper_mao ?? null,
      landlord_mao: range.dual_track?.landlord_mao ?? null,
      rehab_source: rehabPick.source,
      manual_review: manualReview,
      airtable_write: !skipWrite && arv.arv_mid != null,
      airtable_error: airtableError,
      duration_ms: Date.now() - t0,
    },
    decision: manualReview ? "manual_review" : confidence,
    recordId,
  });

  return NextResponse.json({
    record_id: recordId,
    address: listing.address,
    city: listing.city,
    state: listing.state,
    zip: listing.zip,
    arv: {
      low: arv.arv_low,
      mid: arv.arv_mid,
      high: arv.arv_high,
      method: arv.arv_method,
      avg_per_sqft: arv.avg_per_sqft,
      comp_count_used: arv.comp_count_used,
      comp_count_excluded: arv.comp_count_excluded,
      market: arv.market,
      data_state_default: arv.data_state_default,
      confidence_internal: arv.confidence,
      cross_method_disagreement: arv.cross_method_disagreement,
    },
    confidence,
    manual_review: manualReview,
    range,
    source_comps: arv.comps_used,
    audit: {
      validated_at: nowIso,
      airtable_write: !skipWrite && arv.arv_mid != null,
      airtable_error: airtableError,
      duration_ms: Date.now() - t0,
    },
  });
}
