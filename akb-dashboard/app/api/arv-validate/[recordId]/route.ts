// Record-based ARV wrapper. The math layer moved to
// /api/arv-intelligence/[zip] (stateless, source of truth for ARV).
//
// This route stays for dashboard backward-compat: it reads the listing
// from Airtable, calls the stateless endpoint via internal logic, then
// derives Investor_MAO + Your_MAO using existing constants and persists
// to the same Airtable fields the dashboard reads. The buyer math
// formula here is a placeholder until Phase 4C (Week 2) lands the dual-
// track Pricing Agent — same constants as before so the dashboard
// behavior doesn't shift on this refactor.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { getSaleComparables } from "@/lib/rentcast";
import { computeArvIntelligence } from "@/lib/arv-intelligence";
import { audit } from "@/lib/audit-log";
import type { ArvValidationResult } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const cache: Record<string, { data: ArvValidationResult; ts: number }> = {};

// Legacy buyer-math constants. Held here verbatim so the refactor is
// purely additive — Phase 4C (Week 2) will replace this block with the
// dual-track flipper + landlord math.
const DEFAULT_BUYER_PROFIT = 30_000;
const DEFAULT_WHOLESALE_FEE = 15_000;
const CLOSING_COST_PCT = 0.13;

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

  const arv = computeArvIntelligence(comps, {
    zip: listing.zip,
    beds: listing.bedrooms,
    baths: listing.bathrooms,
    sqft: listing.buildingSqFt,
  });

  let investor_mao: number | null = null;
  let your_mao: number | null = null;
  let your_mao_pct: number | null = null;

  if (arv.arv_mid != null && listing.estRehabMid != null) {
    investor_mao = Math.round(
      arv.arv_mid - listing.estRehabMid - arv.arv_mid * CLOSING_COST_PCT - DEFAULT_BUYER_PROFIT,
    );
    your_mao = investor_mao - DEFAULT_WHOLESALE_FEE;
    if (listing.listPrice && listing.listPrice > 0) {
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
    await updateListingRecord(recordId, {
      Real_ARV_Low: arv.arv_low,
      Real_ARV_High: arv.arv_high,
      Real_ARV_Median: arv.arv_mid,
      Investor_MAO: investor_mao,
      Your_MAO: your_mao,
      Auto_Approve_v2: result.auto_approve_v2,
      ARV_Validated_At: result.validated_at,
    });
  } catch (err) {
    console.error(`[arv-validate] Failed to persist for ${recordId}:`, err);
  }

  await audit({
    agent: "phase4a-wrapper",
    event: "arv_validated",
    recordId,
    inputSummary: {
      address: listing.address,
      zip: listing.zip,
      sqft: listing.buildingSqFt,
      est_rehab_mid: listing.estRehabMid,
    },
    outputSummary: {
      arv_mid: arv.arv_mid,
      comp_count_used: arv.comp_count_used,
      filter_quality: arv.filter_quality,
      investor_mao,
      your_mao,
      spread_label,
    },
    decision: spread_label,
    ms: Date.now() - t0,
  });

  cache[recordId] = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}
