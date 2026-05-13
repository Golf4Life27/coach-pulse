// Record-based ARV wrapper. Math comes from two stateless sources of
// truth: /api/arv-intelligence/[zip] (Phase 4A) and lib/pricing-math.ts
// (Phase 4C). This route reads the listing from Airtable, calls the
// shared math, persists to the same Airtable fields the dashboard reads,
// and returns the legacy ArvValidationResult shape.
//
// Phase 4C lands the flipper track here (single Your_MAO field on the
// dashboard). The landlord track + recommended_track + creative_finance
// flag are computed by /api/pricing-intelligence/[zip] but not written
// to Airtable yet — that requires field-ID coordination with Alex.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { getSaleComparables } from "@/lib/rentcast";
import { computeArvIntelligence } from "@/lib/arv-intelligence";
import { computeDualTrackPricing } from "@/lib/pricing-math";
import { audit } from "@/lib/audit-log";
import type { ArvValidationResult } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const cache: Record<string, { data: ArvValidationResult; ts: number }> = {};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const t0 = Date.now();
  const { recordId } = await params;
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", recordId }, { status: 400 });
  }

  const cached = cache[recordId];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  if (!process.env.RENTCAST_API_KEY) {
    return NextResponse.json({ error: "RENTCAST_API_KEY not set" }, { status: 500 });
  }

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found", recordId }, { status: 404 });
  }
  const state = listing.state ?? null;
  if (!listing.address || !listing.city || !state || !listing.zip) {
    return NextResponse.json({ error: "Listing missing address parts", recordId }, { status: 422 });
  }
  if (listing.estRehabMid == null) {
    return NextResponse.json(
      { error: "Run /api/photo-analysis first — Est_Rehab_Mid is required", recordId },
      { status: 422 },
    );
  }

  let comps;
  try {
    comps = await getSaleComparables({
      address: listing.address,
      city: listing.city,
      state,
      zip: listing.zip,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      squareFootage: listing.buildingSqFt,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "RentCast call failed", detail: String(err), recordId },
      { status: 502 },
    );
  }

  // condition_target=renovated is the agent default — ARV math always
  // targets the after-rehab retail value for offer purposes. Pass
  // estRehabMid so the uplift model can fire in Detroit/Memphis where
  // the comp cluster represents as-is. See lib/arv-intelligence.ts.
  const arv = computeArvIntelligence(comps, {
    zip: listing.zip,
    beds: listing.bedrooms,
    baths: listing.bathrooms,
    sqft: listing.buildingSqFt,
    condition_target: "renovated",
    rehab_mid: listing.estRehabMid,
  });

  let investor_mao: number | null = null;
  let your_mao: number | null = null;
  let your_mao_pct: number | null = null;

  // Phase 4C flipper track (dashboard reads single Your_MAO). The
  // landlord track is available via /api/pricing-intelligence/[zip] but
  // is not written to Airtable yet — pending Alex's confirmation of
  // landlord MAO + creative-finance-flag field IDs.
  if (arv.arv_mid != null && listing.estRehabMid != null) {
    const pricing = computeDualTrackPricing({
      zip: listing.zip,
      arv_mid: arv.arv_mid,
      rehab_mid: listing.estRehabMid,
      rent_monthly: null, // wrapper runs flipper-only for dashboard contract
    });
    investor_mao = pricing.flipper?.investor_mao ?? null;
    your_mao = pricing.flipper?.your_mao ?? null;
    if (listing.listPrice && listing.listPrice > 0 && your_mao != null) {
      your_mao_pct = your_mao / listing.listPrice;
    }
  }

  const spread_label: ArvValidationResult["spread_label"] =
    your_mao_pct == null
      ? "negative"
      : your_mao_pct >= 0.65
        ? "positive"
        : your_mao_pct >= 0.5
          ? "tight"
          : "negative";

  const result: ArvValidationResult = {
    recordId,
    arv_low: arv.arv_low,
    arv_high: arv.arv_high,
    arv_median: arv.arv_mid,
    comp_count: arv.comp_count_used,
    as_is_value: null,
    investor_mao,
    your_mao,
    your_mao_pct,
    spread_label,
    auto_approve_v2: spread_label === "positive" && (your_mao ?? 0) > 0,
    validated_at: new Date().toISOString(),
  };

  try {
    // Investor_MAO / Your_MAO / Auto_Approve_v2 are FORMULA fields on
    // Listings_V1 (verified 5/13). Writes 422 and — because PATCH is
    // atomic — would kill every other field in the same request. The
    // dashboard reads the formula output, which computes from
    // Real_ARV_Median + Est_Rehab + Buyer_Profit_Target + Wholesale_Fee_Target.
    // Pricing Agent writes Est_Rehab (the formula's referenced field);
    // this wrapper only writes ARV-side fields.
    await updateListingRecord(recordId, {
      Real_ARV_Low: arv.arv_low,
      Real_ARV_High: arv.arv_high,
      Real_ARV_Median: arv.arv_mid,
      ARV_Validated_At: result.validated_at,
    });
  } catch (err) {
    console.error(`[arv-validate] Failed to persist for ${recordId}:`, err);
  }

  await audit({
    agent: "phase4a-wrapper",
    event: "arv_validated",
    status: "confirmed_success",
    recordId,
    inputSummary: {
      address: listing.address,
      zip: listing.zip,
      sqft: listing.buildingSqFt,
      est_rehab_mid: listing.estRehabMid,
    },
    outputSummary: {
      arv_mid: arv.arv_mid,
      arv_method: arv.arv_method,
      arv_as_is_mid: arv.arv_as_is.mid,
      arv_renovated_mid: arv.arv_renovated.mid,
      data_state_default: arv.data_state_default,
      market: arv.market,
      comp_count_used: arv.comp_count_used,
      filter_quality: arv.filter_quality,
      investor_mao,
      your_mao,
      spread_label,
    },
    decision: spread_label,
    ms: Date.now() - t0,
  });

  if (arv.cross_method_disagreement.fired) {
    await audit({
      agent: "phase4a-wrapper",
      event: "arv_cross_method_disagreement",
      status: "uncertain",
      recordId,
      inputSummary: { zip: listing.zip, market: arv.market },
      outputSummary: {
        cluster_mid: arv.cross_method_disagreement.cluster_mid,
        uplift_mid: arv.cross_method_disagreement.uplift_mid,
        delta_pct: arv.cross_method_disagreement.delta_pct,
        threshold_pct: arv.cross_method_disagreement.threshold_pct,
        consensus_mid: arv.arv_renovated.mid,
      },
      decision: "flag_for_review",
    });
  }

  cache[recordId] = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}
