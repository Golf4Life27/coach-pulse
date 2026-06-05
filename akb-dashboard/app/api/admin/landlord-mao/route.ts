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
import {
  computeInvestorMao,
  computeYourMao,
  DEFAULT_WHOLESALE_FEE,
  evaluatePreContractMath,
} from "@/lib/pre-contract-math";
import { takeLowerMao, type LaneMAO } from "@/lib/lower-lane";
import { defaultInvestorCapFor } from "@/lib/landlord-hydrate";
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

// Operative investor-cap defaults (10% transitional zips / 9% TX / 11% TN)
// now live in lib/landlord-hydrate.ts so the cron + this report share one
// source of truth (imported as defaultInvestorCapFor above).

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

  // Operative investor cap. Pass ?investor_cap=<n> to apply a single
  // confirmed cap to ALL records. Otherwise the operator-confirmed
  // per-market defaults apply (10% transitional zips / 9% TX / 11% TN).
  const capRaw = url.searchParams.get("investor_cap");
  const confirmedCapParam = capRaw != null ? Number(capRaw) : NaN;
  const explicitInvestorCap =
    Number.isFinite(confirmedCapParam) && confirmedCapParam > 0 && confirmedCapParam < 1 ? confirmedCapParam : null;

  // Per-record annual property tax override (re-sourced from county CAD).
  // Format: ?taxes_override=recA:3500,recB:2800  (or single number for
  // ad-hoc single-record runs).
  const taxesOverrideMap = new Map<string, number>();
  const taxesOverrideRaw = url.searchParams.get("taxes_override");
  if (taxesOverrideRaw) {
    for (const pair of taxesOverrideRaw.split(",")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const [maybeId, maybeN] = trimmed.includes(":") ? trimmed.split(":") : [null, trimmed];
      const n = Number(maybeN);
      if (Number.isFinite(n) && n > 0) {
        if (maybeId && maybeId.startsWith("rec")) taxesOverrideMap.set(maybeId.trim(), Math.round(n));
        else if (!maybeId && recordIds.length === 1) taxesOverrideMap.set(recordIds[0], Math.round(n));
      }
    }
  }

  const fee = DEFAULT_WHOLESALE_FEE;

  const results = [];
  for (const recordId of recordIds) {
    const listing = await getListing(recordId);
    if (!listing) {
      results.push({ recordId, error: "listing_not_found" });
      continue;
    }
    const addr = { address: listing.address ?? "", city: listing.city ?? "", state: listing.state ?? "", zip: listing.zip ?? "" };

    const [rentEst, rentcastTaxes, capFloorSrc] = await Promise.all([
      getRentEstimate(addr).catch(() => null),
      getAnnualPropertyTaxes(addr).catch(() => null),
      addr.zip ? sourceMarketCapRate(addr.zip, opexRatio).catch(() => null) : Promise.resolve(null),
    ]);

    // Tax precedence: ?taxes_override (operator-confirmed re-source) wins
    // over the RentCast value. Both surfaced in the response for audit.
    const taxesOverride = taxesOverrideMap.get(recordId) ?? null;
    const taxes = taxesOverride ?? rentcastTaxes;

    const monthlyRent = rentEst?.rent ?? null;
    const marketImpliedFloor = capFloorSrc?.marketImpliedCap ?? null;
    const estRehab = (listing.estRehabMid ?? listing.estRehab ?? null) as number | null;

    const band = investorCapBand(listing.state, addr.zip);

    // Per-record operative cap: explicit override > confirmed default.
    const operativeCap = explicitInvestorCap ?? defaultInvestorCapFor(listing.state, addr.zip);

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

    // Landlord lane @ operative cap.
    let landlordOperative: {
      status: "ok" | "hold" | "block";
      investor_cap: number | null;
      landlord_value: number | null;
      investor_mao: number | null;
      your_mao: number | null;
      reason: string;
    };
    if (operativeCap == null) {
      landlordOperative = {
        status: "hold",
        investor_cap: null,
        landlord_value: null,
        investor_mao: null,
        your_mao: null,
        reason: "Landlord HOLD — no operative cap (no default for this state/zip, no explicit ?investor_cap).",
      };
    } else {
      const floor = checkCapFloor(operativeCap, marketImpliedFloor);
      const ll = computeLandlordMax({ monthlyRent, annualTaxes: taxes, opexRatio, capRate: operativeCap });
      const investorMao = ll.status === "ok" ? computeInvestorMao(ll.landlordValue, estRehab) : null;
      const yourMao = computeYourMao(investorMao, fee);
      let status: "ok" | "hold" | "block";
      let reason: string;
      if (!floor.ok) {
        status = "block";
        reason = `Landlord BLOCK — ${floor.reason}`;
      } else if (ll.status !== "ok" || investorMao == null || yourMao == null) {
        status = "hold";
        reason = `Landlord HOLD — ${ll.status !== "ok" ? ll.reason : "Est_Rehab missing (need rehab to compute Investor_MAO)"}`;
      } else if (yourMao <= 0) {
        status = "block";
        reason = `Landlord BLOCK — Your_MAO=$${yourMao.toLocaleString()} ≤ 0; income math does not support a wholesale spread.`;
      } else if (listing.contractOfferPrice != null && listing.contractOfferPrice > yourMao) {
        status = "block";
        reason = `Landlord BLOCK — Contract $${listing.contractOfferPrice.toLocaleString()} > Your_MAO $${yourMao.toLocaleString()}.`;
      } else {
        status = "ok";
        reason = `Landlord Your_MAO=$${yourMao?.toLocaleString()} at operative cap ${(operativeCap * 100).toFixed(2)}%.`;
      }
      landlordOperative = { status, investor_cap: operativeCap, landlord_value: ll.landlordValue, investor_mao: investorMao, your_mao: yourMao, reason };
    }

    // Flipper lane (V2.1: Buyer_Median − Est_Rehab − Fee). HOLDs on
    // every record in prod until Buyer_Median writers ship — but we
    // still run it so the lower-of-two guard cross-checks.
    const flipperEval = evaluatePreContractMath({
      contractOfferPrice: listing.contractOfferPrice ?? null,
      buyerMedian: (listing as { buyerMedianValue?: number | null }).buyerMedianValue ?? null,
      estRehab,
      cmaValidatedAt: listing.arvValidatedAt ?? null,
    });

    // Lower-of-two-lanes guard: when BOTH lanes compute, take the LOWER
    // Your_MAO. Permissive lane never overrides a tighter ceiling.
    const landlordLaneMao: LaneMAO = {
      lane: "landlord",
      status: landlordOperative.status,
      investorMao: landlordOperative.investor_mao,
      yourMao: landlordOperative.your_mao,
      reason: landlordOperative.reason,
    };
    const flipperLaneMao: LaneMAO = {
      lane: "flipper",
      // pre-contract-math uses "pass"/"hold"/"block"; LaneMAO uses
      // "ok"/"hold"/"block". Map pass→ok.
      status: flipperEval.status === "pass" ? "ok" : flipperEval.status,
      investorMao: flipperEval.investorMao,
      yourMao: flipperEval.yourMao,
      reason: flipperEval.message,
    };
    const guard = takeLowerMao(landlordLaneMao, flipperLaneMao);

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
        county_taxes_source: taxesOverride != null ? "operator_override_pending_confirmation" : "rentcast_properties",
        rentcast_taxes_raw: rentcastTaxes,
        taxes_override: taxesOverride,
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
      landlord_lane: landlordOperative,
      flipper_lane: {
        status: flipperEval.status,
        investor_mao: flipperEval.investorMao,
        your_mao: flipperEval.yourMao,
        reason: flipperEval.message,
      },
      operative_mao: {
        lane: guard.operative.lane,
        investor_mao: guard.operative.investorMao,
        your_mao: guard.operative.yourMao,
        margin_between_lanes: guard.marginBetweenLanes,
        reason: guard.reason,
        guard: "lower_of_two_lanes_takes_lower_mao",
      },
    });

    console.log(
      `LANDLORD_MAO ${recordId} ${listing.address ?? ""} tier=${band.tier} rent=${monthlyRent ?? "-"} ` +
      `taxes=${taxes ?? "-"}${taxesOverride != null ? "*ovr" : ""} rehab=${estRehab ?? "-"} opex=${opexRatio} ` +
      `mkt_floor=${marketImpliedFloor ?? "-"} op_cap=${landlordOperative.investor_cap ?? "-"} ` +
      `landlord=${landlordOperative.your_mao ?? "-"}/${landlordOperative.status} ` +
      `flipper=${flipperEval.yourMao ?? "-"}/${flipperEval.status} ` +
      `OP_LANE=${guard.operative.lane} OP_YMAO=${guard.operative.yourMao ?? "-"} ` +
      `band=[${candidateRows.map((c) => c.your_mao ?? "-").join(",")}]`,
    );
  }

  await audit({
    agent: "appraiser",
    event: "landlord_mao_report",
    status: "confirmed_success",
    inputSummary: { recordIds, opexRatio, fee, explicitInvestorCap, taxesOverrideRecords: Array.from(taxesOverrideMap.keys()) },
    outputSummary: { count: results.length, opex_pending_confirmation: opexRatio, explicit_cap_supplied: explicitInvestorCap != null, taxes_overrides: taxesOverrideMap.size },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    note:
      "REPORT ONLY — no writes, no offers. Operative cap = sourced investor-required cap (market-implied cap is AVM-contaminated → floor sanity-check only). " +
      "Operative MAO applies the LOWER-OF-TWO-LANES GUARD across landlord (rent-cap) + flipper (Buyer_Median); permissive lane cannot override a tighter ceiling. " +
      "Tax overrides via ?taxes_override=recA:N,recB:N apply confirmed county-CAD values per record. PENDING operator confirmation before any number drives offers.",
    opex_ratio: opexRatio,
    opex_source: NON_TAX_OPEX.source,
    wholesale_fee: fee,
    explicit_investor_cap: explicitInvestorCap,
    defaults_note:
      "Per-record operative cap defaults (operator-confirmed 2026-06-05): 10% for TRANSITIONAL_ZIPS (currently {78228}), 9% for other TX, 11% for TN. Override via ?investor_cap=<n>.",
    taxes_override_records: Array.from(taxesOverrideMap.entries()).map(([id, n]) => ({ recordId: id, taxes: n })),
    results,
    elapsed_ms: Date.now() - t0,
  });
}
