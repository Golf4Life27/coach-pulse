// Landlord-lane MAO report — Track 2 (2026-06-05).
// @agent: appraiser / orchestrator
//
// GET /api/admin/landlord-mao?recordIds=rec1,rec2[&opex=0.40]
//
// Produces a rent-based (income-approach) MAO for each record and
// surfaces the SOURCED market cap rate + every assumption for Maverick
// source-confirmation. This is a REPORT surface — it does NOT write
// Airtable and does NOT drive any live offer. Per the brief: "Return the
// sourced cap rate(s) per-market to Maverick for source-confirmation
// before it drives any live offer."
//
// Per record:
//   rent     = RentCast rent AVM (getRentEstimate)
//   taxes    = RentCast property record (getAnnualPropertyTaxes)
//   cap rate = RentCast /markets DERIVED (sourceMarketCapRate) — sourced,
//              never hardcoded; null → HOLD
//   landlord_value = NOI / cap       (lib/landlord-lane)
//   Investor_MAO   = landlord_value − Est_Rehab
//   Your_MAO       = Investor_MAO − Wholesale_Fee
//
// Missing ANY input → HOLD on that record (no fabricated number). The
// existing Buyer_Median lane is run alongside for comparison (it HOLDs
// in prod — zero Buyer_Median writers — which is the whole reason the
// landlord lane exists).
//
// Auth: /api/admin/* convention (Vercel deployment layer). Read-only.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { getRentEstimate, getAnnualPropertyTaxes } from "@/lib/rentcast";
import { sourceMarketCapRate } from "@/lib/cap-rate-source";
import { computeLandlordMax } from "@/lib/landlord-lane";
import {
  computeInvestorMao,
  computeYourMao,
  evaluatePreContractMath,
  DEFAULT_WHOLESALE_FEE,
} from "@/lib/pre-contract-math";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 120;

// Operating-expense ratio (fraction of gross rent; excludes taxes, which
// are explicit, and debt service). Standard buy-hold underwriting
// assumption — surfaced in every result + flagged for Maverick
// confirmation. Env-tunable; NOT a hidden default. Used for BOTH the
// subject NOI and the market cap-rate derivation (consistent; errs
// conservative on value).
const DEFAULT_OPEX_RATIO = Number(process.env.LANDLORD_OPEX_RATIO ?? "0.40");

// The two DoD records + 23 Fields (must still BLOCK) when no ?recordIds.
const DEFAULT_RECORD_IDS = [
  "recG4GNM2sa0ZYj7p", // 5435 Callaghan Rd, San Antonio TX 78228
  "recd3aN6DLdBmMJV4", // 11114 Dreamland Dr, San Antonio TX 78230
  "rec1HTUqK0YEVb7uA", // 23 Fields Ave (control — must BLOCK)
];

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const idsParam = url.searchParams.get("recordIds");
  const recordIds = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter((s) => s.startsWith("rec"))
    : DEFAULT_RECORD_IDS;
  // BUGFIX: Number(null) === 0, which would pass the (≥0 && <1) guard and
  // silently zero the opex (no expense haircut → inflated values). Only
  // override the default when an explicit, valid ?opex is supplied.
  const opexRaw = url.searchParams.get("opex");
  const opexParam = opexRaw != null ? Number(opexRaw) : NaN;
  const opexRatio =
    Number.isFinite(opexParam) && opexParam > 0 && opexParam < 1 ? opexParam : DEFAULT_OPEX_RATIO;
  const fee = DEFAULT_WHOLESALE_FEE;

  const results = [];
  for (const recordId of recordIds) {
    const listing = await getListing(recordId);
    if (!listing) {
      results.push({ recordId, error: "listing_not_found" });
      continue;
    }
    const addr = { address: listing.address ?? "", city: listing.city ?? "", state: listing.state ?? "", zip: listing.zip ?? "" };

    // Parallel data pulls. Each degrades to null on failure (→ HOLD).
    const [rentEst, taxes, capSource] = await Promise.all([
      getRentEstimate(addr).catch(() => null),
      getAnnualPropertyTaxes(addr).catch(() => null),
      addr.zip ? sourceMarketCapRate(addr.zip, opexRatio).catch(() => null) : Promise.resolve(null),
    ]);

    const monthlyRent = rentEst?.rent ?? null;
    const capRate = capSource?.capRate ?? null;
    const estRehab = (listing.estRehabMid ?? listing.estRehab ?? null) as number | null;

    const landlord = computeLandlordMax({ monthlyRent, annualTaxes: taxes, opexRatio, capRate });

    // Landlord-lane MAO: landlord_value plays the role of the ARV/comp
    // floor that the investor underwrites to (same shape as the
    // Buyer_Median lane, different basis).
    const investorMaoLandlord = landlord.status === "ok"
      ? computeInvestorMao(landlord.landlordValue, estRehab)
      : null;
    const yourMaoLandlord = computeYourMao(investorMaoLandlord, fee);

    // Existing Buyer_Median lane for comparison.
    const buyerMedianLane = evaluatePreContractMath({
      contractOfferPrice: listing.contractOfferPrice ?? null,
      buyerMedian: (listing as { buyerMedianValue?: number | null }).buyerMedianValue ?? null,
      estRehab,
      cmaValidatedAt: listing.arvValidatedAt ?? null,
    });

    // The reportable MAO + its gate status.
    let maoStatus: "ok" | "hold" | "block";
    if (landlord.status !== "ok" || investorMaoLandlord == null || yourMaoLandlord == null) {
      maoStatus = "hold";
    } else if (yourMaoLandlord <= 0) {
      maoStatus = "block";
    } else if (listing.contractOfferPrice != null && listing.contractOfferPrice > yourMaoLandlord) {
      maoStatus = "block";
    } else {
      maoStatus = "ok";
    }

    const row = {
      recordId,
      address: listing.address,
      zip: addr.zip,
      contractOfferPrice: listing.contractOfferPrice ?? null,
      inputs: {
        monthly_rent: monthlyRent,
        annual_taxes: taxes,
        est_rehab: estRehab,
        opex_ratio: opexRatio,
        cap_rate: capRate,
        wholesale_fee: fee,
      },
      cap_rate_source: capSource
        ? { capRate: capSource.capRate, grossYield: capSource.grossYield, medianSalePrice: capSource.medianSalePrice, medianRent: capSource.medianRent, source: capSource.source, provenance: capSource.provenance, error: capSource.error }
        : { error: "zip missing" },
      landlord: {
        status: landlord.status,
        landlord_value: landlord.landlordValue,
        annual_noi: landlord.annualNoi,
        missing: landlord.missing,
        reason: landlord.reason,
      },
      landlord_mao: {
        status: maoStatus,
        investor_mao: investorMaoLandlord,
        your_mao: yourMaoLandlord,
      },
      buyer_median_lane: {
        status: buyerMedianLane.status,
        investor_mao: buyerMedianLane.investorMao,
        your_mao: buyerMedianLane.yourMao,
        message: buyerMedianLane.message,
      },
    };
    results.push(row);

    console.log(
      `LANDLORD_MAO ${recordId} ${listing.address ?? ""} zip=${addr.zip} ` +
      `rent=${monthlyRent ?? "-"} taxes=${taxes ?? "-"} rehab=${estRehab ?? "-"} ` +
      `cap=${capRate ?? "-"} value=${landlord.landlordValue ?? "-"} ` +
      `inv_mao=${investorMaoLandlord ?? "-"} your_mao=${yourMaoLandlord ?? "-"} status=${maoStatus}`,
    );
  }

  await audit({
    agent: "appraiser",
    event: "landlord_mao_report",
    status: "confirmed_success",
    inputSummary: { recordIds, opexRatio, fee },
    outputSummary: { count: results.length, opex_pending_confirmation: opexRatio },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    note: "REPORT ONLY — does not write Airtable or drive offers. Cap rates + opex assumption are PENDING MAVERICK SOURCE-CONFIRMATION before any live use.",
    opex_ratio_assumption: opexRatio,
    wholesale_fee: fee,
    results,
    elapsed_ms: Date.now() - t0,
  });
}
