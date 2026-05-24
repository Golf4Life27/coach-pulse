// Phase 3.11a / Q.3 — Unified Deal Math endpoint.
//
// GET /api/deal-math/[recordId]
//
// Canonical-namespace endpoint per the original Phase 3.11 spec.
// Wraps the v1.3 MAO range envelope (computeMaoRange) so external
// callers (Make scenarios, Maverick MCP, BroCard render) have a
// single read-path that returns:
//
//   {
//     recordId,
//     pricing: BroCardPricing,  // same discriminated union the
//                               // BroCard surface consumes
//     range: MaoRange | null,   // raw envelope (or null in legacy/no_math)
//     listing_snapshot: { ... } // the input fields used, for caller audit
//   }
//
// Coexists with the per-agent appraiser endpoints (`/api/agents/
// appraiser/{arv,rehab,buyer-intelligence}/[recordId]`). Those WRITE
// to Airtable; this READS what's there + projects via the math layer.
// Idempotent — no side effects beyond the audit-log entry.
//
// Per v1.3 amendment: returns a range [V2.1 floor, motivation-adjusted
// target]. Target equals floor everywhere today since motivation
// scoring isn't auto-populated (Phase 13.7 lays the wiring); the
// shape is range-shaped from day one so future motivation deltas
// don't require a contract change.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { classifyBroCardPricing } from "@/lib/brocard/pricing";
import { computeMaoRange, pickCalibratedRehab } from "@/lib/appraiser/mao-range";

export const runtime = "nodejs";
export const maxDuration = 15;

type Ctx = { params: Promise<{ recordId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const t0 = Date.now();
  const { recordId } = await params;

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json(
      { error: `Listing ${recordId} not found` },
      { status: 404 },
    );
  }

  const pricing = classifyBroCardPricing(listing);

  // Raw range envelope (separate from the pricing discriminated
  // union — callers that want the original MaoRange shape vs the
  // mode-aware projection get both).
  const rehabPick = pickCalibratedRehab({
    estRehabMid: listing.estRehabMid,
    estRehab: listing.estRehab,
  });
  const range = computeMaoRange({
    arvMid: listing.realArvMedian ?? null,
    estRehab: rehabPick.value,
    wholesaleFee: listing.wholesaleFeeTarget ?? null,
    buyerProfit: listing.buyerProfitTarget ?? null,
    listPrice: listing.listPrice ?? null,
    sellerMotivationScore: listing.sellerMotivationScore ?? null,
    monthlyRent: listing.estimatedMonthlyRent ?? null,
    state: listing.state ?? null,
  });

  await audit({
    agent: "appraiser",
    event: "deal_math_read",
    status: "confirmed_success",
    recordId,
    inputSummary: {
      address: listing.address,
      list_price: listing.listPrice,
      state: listing.state,
    },
    outputSummary: {
      mode: pricing.mode,
      floor: range.floor,
      target: range.target,
      list_price: range.list_price,
      soft_ceiling: range.soft_ceiling,
      exceeds_soft_ceiling: range.exceeds_soft_ceiling,
      dual_track_dominant: range.dual_track?.dominant_track ?? null,
      rehab_source: rehabPick.source,
    },
    decision: pricing.mode,
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    recordId,
    pricing,
    range,
    listing_snapshot: {
      address: listing.address,
      city: listing.city,
      state: listing.state,
      list_price: listing.listPrice,
      real_arv_median: listing.realArvMedian,
      est_rehab_mid: listing.estRehabMid,
      est_rehab: listing.estRehab,
      estimated_monthly_rent: listing.estimatedMonthlyRent,
      seller_motivation_score: listing.sellerMotivationScore,
      wholesale_fee_target: listing.wholesaleFeeTarget,
      buyer_profit_target: listing.buyerProfitTarget,
      outreach_offer_price: listing.outreachOfferPrice,
      contract_offer_price: listing.contractOfferPrice,
      rehab_source: rehabPick.source,
    },
    elapsed_ms: Date.now() - t0,
  });
}
