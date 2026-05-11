import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { getAvmValue, getSaleComparables, median, type RentCastSaleComp } from "@/lib/rentcast";
import type { ArvValidationResult } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const cache: Record<string, { data: ArvValidationResult; ts: number }> = {};

const DEFAULT_BUYER_PROFIT = 30_000;
const DEFAULT_WHOLESALE_FEE = 15_000;
const CLOSING_COST_PCT = 0.13;

function filterComps(comps: RentCastSaleComp[], targetSqft: number | null, targetBeds: number | null): RentCastSaleComp[] {
  const sixMonthsAgo = Date.now() - 6 * 30 * 24 * 60 * 60_000;
  return comps.filter((c) => {
    if (!c.price || c.price <= 0) return false;
    if (c.distance != null && c.distance > 0.5) return false;
    if (c.saleDate) {
      const t = new Date(c.saleDate).getTime();
      if (!isNaN(t) && t < sixMonthsAgo) return false;
    }
    if (targetSqft != null && c.squareFootage != null) {
      const ratio = c.squareFootage / targetSqft;
      if (ratio < 0.8 || ratio > 1.2) return false;
    }
    if (targetBeds != null && c.bedrooms != null) {
      if (c.bedrooms !== targetBeds) return false;
    }
    return true;
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
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
  if (!listing.address || !listing.city || !listing.state || !listing.zip) {
    return NextResponse.json({ error: "Listing missing address parts", recordId }, { status: 422 });
  }
  if (listing.estRehabMid == null) {
    return NextResponse.json(
      { error: "Run /api/photo-analysis first — Est_Rehab_Mid is required", recordId },
      { status: 422 },
    );
  }

  const avmInput = {
    address: listing.address,
    city: listing.city,
    state: listing.state,
    zip: listing.zip,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    squareFootage: listing.buildingSqFt,
  };

  let avm = null as Awaited<ReturnType<typeof getAvmValue>> | null;
  let comps: RentCastSaleComp[] = [];
  try {
    [avm, comps] = await Promise.all([getAvmValue(avmInput), getSaleComparables(avmInput)]);
  } catch (err) {
    console.error(`[arv-validate] RentCast error for ${recordId}:`, err);
    return NextResponse.json(
      { error: "RentCast call failed", detail: String(err), recordId },
      { status: 502 },
    );
  }

  const filteredComps = filterComps(comps, listing.buildingSqFt, listing.bedrooms);
  const compPrices = filteredComps.map((c) => c.price!).filter((p): p is number => p != null);
  const compMedian = median(compPrices);
  const asIs = avm?.price ?? null;

  const arvByComp = compMedian;
  const arvByAvm = asIs != null ? Math.round(asIs * 1.4) : null;
  const arv_median =
    arvByComp != null && arvByAvm != null
      ? Math.max(arvByComp, arvByAvm)
      : (arvByComp ?? arvByAvm);
  const arv_low = compPrices.length > 0 ? Math.min(...compPrices) : (avm?.priceLow ?? null);
  const arv_high = compPrices.length > 0 ? Math.max(...compPrices) : (avm?.priceHigh ?? null);

  let investor_mao: number | null = null;
  let your_mao: number | null = null;
  let your_mao_pct: number | null = null;

  if (arv_median != null && listing.estRehabMid != null) {
    investor_mao = Math.round(
      arv_median - listing.estRehabMid - arv_median * CLOSING_COST_PCT - DEFAULT_BUYER_PROFIT,
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
    arv_low,
    arv_high,
    arv_median,
    comp_count: filteredComps.length,
    as_is_value: asIs,
    investor_mao,
    your_mao,
    your_mao_pct,
    spread_label,
    auto_approve_v2: spread_label === "positive" && (your_mao ?? 0) > 0,
    validated_at: new Date().toISOString(),
  };

  try {
    await updateListingRecord(recordId, {
      Real_ARV_Low: arv_low,
      Real_ARV_High: arv_high,
      Real_ARV_Median: arv_median,
      Investor_MAO: investor_mao,
      Your_MAO: your_mao,
      Auto_Approve_v2: result.auto_approve_v2,
      ARV_Validated_At: result.validated_at,
    });
  } catch (err) {
    console.error(`[arv-validate] Failed to persist for ${recordId}:`, err);
  }

  cache[recordId] = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}
