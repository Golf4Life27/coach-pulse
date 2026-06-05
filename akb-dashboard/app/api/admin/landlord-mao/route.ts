// Landlord-lane MAO report — Track 2 (2026-06-05, cap-basis corrected).
// @agent: appraiser / orchestrator
//
// GET /api/admin/landlord-mao?recordIds=rec1,rec2[&investor_cap=0.10][&opex=0.35]
//
// Produces a rent-based (income-approach) MAO surface for each record
// and returns the OPERATIVE INVESTOR-REQUIRED cap candidates + the full
// conservative expense load + the resulting MAO for Maverick source-
// confirmation. REPORT ONLY — no Airtable writes, no live offers. No
// number drives an offer until the operator confirms the cap against
// real investor data and eyeballs the parameters.
//
// CAP BASIS (corrected per operator): the operative cap is the SOURCED,
// conservatively-high INVESTOR-REQUIRED cap (lib/investor-cap.ts), NOT
// the retail market-implied cap (RentCast median-sale ÷ rent), which is
// retail value, AVM-contaminated in non-disclosure TX, and overstates
// MAO ~30-50%. The market-implied cap is shown ONLY as a floor sanity-
// check (investor cap must be ≥ it).
//
//   landlord_value = annual_NOI / investor_required_cap
//   annual_NOI     = gross_rent − county_taxes − gross_rent×non_tax_opex
//   Investor_MAO   = landlord_value − Est_Rehab        (V2.1 floor)
//   Your_MAO       = Investor_MAO − Wholesale_Fee
//
// When no confirmed ?investor_cap is supplied, the OPERATIVE MAO HOLDs
// (investor_cap_unconfirmed) and the report shows MAO across the
// conservative candidate band so Maverick can confirm. Missing rent /
// taxes / rehab → HOLD (no fabricated numbers).

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { getRentEstimate, getAnnualPropertyTaxes } from "@/lib/rentcast";
import { sourceMarketCapRate } from "@/lib/cap-rate-source";
import { computeLandlordMax, NON_TAX_OPEX } from "@/lib/landlord-lane";
import { investorCapBand, checkCapFloor } from "@/lib/investor-cap";
import { computeInvestorMao, computeYourMao, DEFAULT_WHOLESALE_FEE } from "@/lib/pre-contract-math";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 120;

// Full conservative NON-TAX opex load (insurance + vacancy + maintenance
// + management). County taxes are separate + explicit. Sourced in
// NON_TAX_OPEX; env-tunable for confirmation runs.
const OPEX_RATIO = (() => {
  const raw = process.env.LANDLORD_OPEX_RATIO;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 && n < 1 ? n : NON_TAX_OPEX.ratio;
})();

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

  const opexRaw = url.searchParams.get("opex");
  const opexParam = opexRaw != null ? Number(opexRaw) : NaN;
  const opexRatio = Number.isFinite(opexParam) && opexParam > 0 && opexParam < 1 ? opexParam : OPEX_RATIO;

  // Operative investor cap is ONLY set when the operator/Maverick passes
  // a confirmed ?investor_cap. No confirmed cap → operative MAO HOLDs;
  // we still show the candidate-band sensitivity.
  const capRaw = url.searchParams.get("investor_cap");
  const confirmedCapParam = capRaw != null ? Number(capRaw) : NaN;
  const confirmedInvestorCap =
    Number.isFinite(confirmedCapParam) && confirmedCapParam > 0 && confirmedCapParam < 1 ? confirmedCapParam : null;

  const fee = DEFAULT_WHOLESALE_FEE;

  const results = [];
  for (const recordId of recordIds) {
    const listing = await getListing(recordId);
    if (!listing) {
      results.push({ recordId, error: "listing_not_found" });
      continue;
    }
    const addr = { address: listing.address ?? "", city: listing.city ?? "", state: listing.state ?? "", zip: listing.zip ?? "" };

    const [rentEst, taxes, capFloorSrc] = await Promise.all([
      getRentEstimate(addr).catch(() => null),
      getAnnualPropertyTaxes(addr).catch(() => null),
      addr.zip ? sourceMarketCapRate(addr.zip, opexRatio).catch(() => null) : Promise.resolve(null),
    ]);

    const monthlyRent = rentEst?.rent ?? null;
    const marketImpliedFloor = capFloorSrc?.marketImpliedCap ?? null;
    const estRehab = (listing.estRehabMid ?? listing.estRehab ?? null) as number | null;

    const band = investorCapBand(listing.state, addr.zip);

    // MAO at each candidate investor cap (sensitivity surface). Each uses
    // the SAME full-opex NOI; only the operative cap varies.
    const candidateRows = band.candidates.map((cap) => {
      const ll = computeLandlordMax({ monthlyRent, annualTaxes: taxes, opexRatio, capRate: cap });
      const investorMao = ll.status === "ok" ? computeInvestorMao(ll.landlordValue, estRehab) : null;
      const yourMao = computeYourMao(investorMao, fee);
      const floor = checkCapFloor(cap, marketImpliedFloor);
      return {
        investor_cap: cap,
        landlord_value: ll.landlordValue,
        investor_mao: investorMao,
        your_mao: yourMao,
        floor_check_ok: floor.ok,
      };
    });

    // Operative MAO: ONLY when a confirmed cap is supplied. Otherwise HOLD.
    let operative: {
      status: "ok" | "hold" | "block";
      investor_cap: number | null;
      landlord_value: number | null;
      investor_mao: number | null;
      your_mao: number | null;
      reason: string;
    };
    if (confirmedInvestorCap == null) {
      operative = {
        status: "hold",
        investor_cap: null,
        landlord_value: null,
        investor_mao: null,
        your_mao: null,
        reason: "HOLD — no confirmed investor-required cap. Pass ?investor_cap=<sourced fraction> after confirming against real investor data. Candidate band shown for confirmation.",
      };
    } else {
      const floor = checkCapFloor(confirmedInvestorCap, marketImpliedFloor);
      const ll = computeLandlordMax({ monthlyRent, annualTaxes: taxes, opexRatio, capRate: confirmedInvestorCap });
      const investorMao = ll.status === "ok" ? computeInvestorMao(ll.landlordValue, estRehab) : null;
      const yourMao = computeYourMao(investorMao, fee);
      let status: "ok" | "hold" | "block";
      let reason: string;
      if (!floor.ok) {
        status = "block";
        reason = `BLOCK — ${floor.reason}`;
      } else if (ll.status !== "ok" || investorMao == null || yourMao == null) {
        status = "hold";
        reason = `HOLD — ${ll.status !== "ok" ? ll.reason : "Est_Rehab missing (need rehab to compute Investor_MAO)"}`;
      } else if (yourMao <= 0) {
        status = "block";
        reason = `BLOCK — Your_MAO=$${yourMao.toLocaleString()} ≤ 0; income math does not support a wholesale spread.`;
      } else if (listing.contractOfferPrice != null && listing.contractOfferPrice > yourMao) {
        status = "block";
        reason = `BLOCK — Contract $${listing.contractOfferPrice.toLocaleString()} > Your_MAO $${yourMao.toLocaleString()}.`;
      } else {
        status = "ok";
        reason = `Your_MAO=$${yourMao?.toLocaleString()} at confirmed cap ${(confirmedInvestorCap * 100).toFixed(2)}%.`;
      }
      operative = { status, investor_cap: confirmedInvestorCap, landlord_value: ll.landlordValue, investor_mao: investorMao, your_mao: yourMao, reason };
    }

    const grossRent = monthlyRent != null ? Math.round(monthlyRent * 12) : null;
    results.push({
      recordId,
      address: listing.address,
      zip: addr.zip,
      state: listing.state,
      contractOfferPrice: listing.contractOfferPrice ?? null,
      inputs: {
        monthly_rent: monthlyRent,
        annual_gross_rent: grossRent,
        county_taxes: taxes,
        est_rehab: estRehab,
        wholesale_fee: fee,
      },
      expense_load: {
        non_tax_opex_ratio: opexRatio,
        itemized: { vacancy: NON_TAX_OPEX.vacancy, maintenance: NON_TAX_OPEX.maintenance, management: NON_TAX_OPEX.management, insurance: NON_TAX_OPEX.insurance },
        note: "Applied to gross rent; county property taxes are separate + explicit above.",
        source: NON_TAX_OPEX.source,
      },
      operative_cap_basis: {
        tier: band.tier,
        candidate_band: band.candidates,
        conservative_high: band.conservativeHigh,
        source: band.source,
        market_implied_floor: marketImpliedFloor,
        market_implied_provenance: capFloorSrc?.provenance ?? "unavailable",
      },
      mao_by_candidate_cap: candidateRows,
      operative_mao: operative,
    });

    console.log(
      `LANDLORD_MAO ${recordId} ${listing.address ?? ""} tier=${band.tier} rent=${monthlyRent ?? "-"} ` +
      `taxes=${taxes ?? "-"} rehab=${estRehab ?? "-"} opex=${opexRatio} mkt_floor=${marketImpliedFloor ?? "-"} ` +
      `op_cap=${operative.investor_cap ?? "-"} op_your_mao=${operative.your_mao ?? "-"} status=${operative.status} ` +
      `band_your_mao=[${candidateRows.map((c) => c.your_mao ?? "-").join(",")}]`,
    );
  }

  await audit({
    agent: "appraiser",
    event: "landlord_mao_report",
    status: "confirmed_success",
    inputSummary: { recordIds, opexRatio, fee, confirmedInvestorCap },
    outputSummary: { count: results.length, opex_pending_confirmation: opexRatio, operative_cap_confirmed: confirmedInvestorCap != null },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    note:
      "REPORT ONLY — no writes, no offers. The OPERATIVE cap is the SOURCED investor-required cap (NOT the retail market-implied cap, which is AVM-contaminated and shown only as a floor). " +
      "Cap band + expense load + MAO are PENDING MAVERICK SOURCE-CONFIRMATION + operator eyeball. Pass ?investor_cap=<confirmed fraction> to compute the operative MAO.",
    opex_ratio: opexRatio,
    opex_source: NON_TAX_OPEX.source,
    wholesale_fee: fee,
    confirmed_investor_cap: confirmedInvestorCap,
    results,
    elapsed_ms: Date.now() - t0,
  });
}
