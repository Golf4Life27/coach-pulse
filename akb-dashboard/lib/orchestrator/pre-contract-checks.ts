// Pre-Contract Gate (Gate 4) check functions — 24 items per
// AKB_Deal_Flow_Orchestrator_Spec §4.
//
// Highest-risk gate. Runs when a PA arrives for signing, BEFORE Alex
// signs anything. Spec §13 Test 1 (Briyana 5/12) is the acceptance
// case: would have caught PC-08 (blank EMD escrow holder), PC-20
// (1100 modeled sqft vs 1548 CMA), PC-22 (recompute math negative
// with PA-final numbers).
//
// Phase 1 scope
// 6 items fire real:
//   PC-16  Memphis assignability (TN check from listing)
//   PC-17  CMA pulled
//   PC-20  Sqft vs CMA (partial — PA side data_missing)
//   PC-22  Recompute math (partial — uses current listing inputs)
//   PC-23  Buyer pipeline ≥3 in ZIP
//   PC-24  Final confidence composite
//
// 18 items return data_missing pending DocuSign MCP integration. This
// makes the gate principle-block-everything-for-now: until DocuSign
// wires in, no PA can advance to under_contract through this gate.
// That's the principle-correct default — better than passing without
// verification of the document itself.
//
// Inviolable items per spec §7 (override-resistant once DocuSign wires):
//   PC-05  Inspection contingency
//   PC-16  Memphis assignability

import preContractConfig from "@/lib/config/gates/pre_contract.json";
import type { CheckFn, CheckResult, ChecklistItem, Gate } from "./types";

export const PRE_CONTRACT_GATE: Gate = {
  id: preContractConfig.gate_id,
  stage_from: preContractConfig.stage_from as Gate["stage_from"],
  stage_to: preContractConfig.stage_to as Gate["stage_to"],
  items: preContractConfig.items as ChecklistItem[],
};

export const PRE_CONTRACT_CONFIG = preContractConfig.config as {
  inspection_period_min_days: number;
  inspection_period_max_days: number;
  closing_date_min_days_from_sign: number;
  emd_max_pct_of_sale_price: number;
  buyer_entity_required: string;
  buyer_entity_acceptable_variants: string[];
  lead_paint_disclosure_year_cutoff: number;
  sqft_variance_block_pct: number;
  buyer_pipeline_min_in_zip: number;
  tn_assignability_states: string[];
  confidence_recommend_sign_threshold: number;
  confidence_human_review_threshold: number;
};

// ── Helpers ───────────────────────────────────────────────────────────

function pass(item_id: string, reasoning: string, data_examined: Record<string, unknown>, failure_action: ChecklistItem["failure_action"] = "block"): CheckResult {
  return { item_id, status: "pass", reasoning, data_examined, failure_action };
}
function fail(item_id: string, reasoning: string, data_examined: Record<string, unknown>, failure_action: ChecklistItem["failure_action"] = "block"): CheckResult {
  return { item_id, status: "fail", reasoning, data_examined, failure_action };
}
function dataMissing(item_id: string, reasoning: string, data_examined: Record<string, unknown>, failure_action: ChecklistItem["failure_action"] = "block"): CheckResult {
  return { item_id, status: "data_missing", reasoning, data_examined, failure_action };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// Phase 1 helper: produces a "DocuSign-pending" data_missing result with
// consistent reasoning + data_examined shape. Used by every PC item that
// reads from pa_document in Phase 1.
function docuSignPending(item_id: string, what: string, failure_action: ChecklistItem["failure_action"] = "block"): CheckResult {
  return dataMissing(
    item_id,
    `Phase 1: ${what} requires DocuSign envelope parse. DocuSign MCP not yet wired (server ab943441-29da-4bcb-8d3f-19efc0412d6c announced but tool schemas not in deferred-tools registry).`,
    {
      missing_data_source: "pa_document",
      phase: 1,
      blocked_on: "docusign_mcp_wire_in",
      phase_2_note: "Once DocuSign MCP loads, replace this stub with a real envelope/form-field check",
    },
    failure_action,
  );
}

// ── Checks ────────────────────────────────────────────────────────────

const PC_01_pull_pa: CheckFn = () =>
  docuSignPending("PC-01", "PA envelope + attachments retrieval");
const PC_02_sale_price_matches: CheckFn = () =>
  docuSignPending("PC-02", "sale_price vs negotiation thread cross-reference");
const PC_03_buyer_entity: CheckFn = () =>
  docuSignPending("PC-03", "buyer_entity = 'AKB Solutions LLC and/or assigns' verification");
const PC_04_cash_financing: CheckFn = () =>
  docuSignPending("PC-04", "cash financing box check");
const PC_05_inspection_contingency: CheckFn = () =>
  docuSignPending("PC-05", "inspection contingency presence (INVIOLABLE per spec §7)");
const PC_06_inspection_period: CheckFn = () =>
  docuSignPending("PC-06", "inspection period within 5-10 days check", "warn");
const PC_07_closing_date: CheckFn = () =>
  docuSignPending("PC-07", "closing date ≥14 days from sign date", "warn");
const PC_08_emd_escrow: CheckFn = () =>
  docuSignPending("PC-08", "EMD escrow holder = title company verification");
const PC_09_emd_amount: CheckFn = () =>
  docuSignPending("PC-09", "EMD amount ≤1% sale price check", "warn");
const PC_10_possession: CheckFn = () =>
  docuSignPending("PC-10", "possession at closing verification", "warn");
const PC_11_lead_paint: CheckFn = () =>
  docuSignPending("PC-11", "lead paint disclosure (if pre-1978) verification", "warn");
const PC_12_attachments: CheckFn = () =>
  docuSignPending("PC-12", "required attachments enumeration");
const PC_13_no_blank_dollars: CheckFn = () =>
  docuSignPending("PC-13", "blank-dollar-field scan");
const PC_14_pa_vs_thread: CheckFn = () =>
  docuSignPending("PC-14", "PA terms vs negotiation thread cross-reference");
const PC_15_state_assignment: CheckFn = () =>
  docuSignPending("PC-15", "per-state assignment clause verification");

const PC_16_memphis_assignability: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_CONTRACT_CONFIG;
  const state = ctx.listing?.state;
  if (!state) {
    return dataMissing("PC-16", "listing.state unset — can't determine TN applicability", {
      missing_data_source: "airtable_listing.State",
      recordId: ctx.recordId,
    });
  }
  const isTN = c.tn_assignability_states.some(
    (s) => s.toLowerCase() === state.trim().toLowerCase(),
  );
  if (!isTN) {
    return pass(
      "PC-16",
      `state="${state}" — not in TN, Memphis assignability check N/A`,
      { state, tn_states: c.tn_assignability_states },
    );
  }
  // For TN listings, this is an informational requirement that the PA
  // MUST carry Memphis-compliant assignment language. Phase 1 can't
  // verify the PA itself (DocuSign-pending) — so for TN this is
  // data_missing on the PA side. Inviolable per spec §7.
  return dataMissing(
    "PC-16",
    `state="${state}" — TN. PA must include Memphis-compliant assignment language. INVIOLABLE per spec §7 (override not permitted). DocuSign integration required to verify PA carries the clause.`,
    {
      state,
      requirement: "memphis_assignability_clause",
      inviolable: true,
      missing_data_source: "pa_document",
      recordId: ctx.recordId,
    },
  );
};

const PC_17_pull_cma: CheckFn = (ctx) => {
  const cma = ctx.cma;
  if (cma == null) {
    return dataMissing("PC-17", "CMA fetch failed", {
      missing_data_source: "cma",
      recordId: ctx.recordId,
    });
  }
  if (cma.length === 0) {
    return fail("PC-17", "RentCast returned 0 comparables", { comp_count_raw: 0 });
  }
  return pass("PC-17", `CMA pulled (${cma.length} comps)`, { comp_count_raw: cma.length });
};

const PC_18_ownership_match: CheckFn = () =>
  docuSignPending("PC-18", "PA seller_name vs property records match", "warn");

const PC_19_title_prelim: CheckFn = (ctx) => {
  return dataMissing(
    "PC-19",
    "Phase 1: title prelim workflow is manual. No title_prelim source wired.",
    {
      missing_data_source: "title_prelim",
      phase: 1,
      recordId: ctx.recordId,
    },
    "warn",
  );
};

const PC_20_sqft_match: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_CONTRACT_CONFIG;
  const listingSqft = ctx.listing?.buildingSqFt;
  const compSqfts = (ctx.cma ?? [])
    .map((cp) => cp.squareFootage)
    .filter((s): s is number => s != null && s > 0);
  if (listingSqft == null) {
    return dataMissing("PC-20", "listing.buildingSqFt unset", {
      missing_data_source: "airtable_listing.Building_SqFt",
      recordId: ctx.recordId,
    });
  }
  if (compSqfts.length === 0) {
    return dataMissing("PC-20", "No CMA comps with sqft — can't compute median", {
      missing_data_source: "cma[].squareFootage",
      recordId: ctx.recordId,
    });
  }
  const cmaMedian = median(compSqfts)!;
  const listingVariance = Math.abs(listingSqft - cmaMedian) / cmaMedian;
  if (listingVariance > c.sqft_variance_block_pct) {
    // Listing-side variance is real; PA-side is pending. Block on
    // listing-side mismatch regardless — same logic as PN-07.
    return fail(
      "PC-20",
      `Listing Building_SqFt=${listingSqft} differs from CMA median ${Math.round(cmaMedian)} by ${(listingVariance * 100).toFixed(0)}% (>${(c.sqft_variance_block_pct * 100).toFixed(0)}% threshold). PA-side comparison also pending DocuSign.`,
      {
        listing_sqft: listingSqft,
        cma_median_sqft: Math.round(cmaMedian),
        listing_vs_cma_variance_pct: listingVariance,
        pa_sqft: "data_missing (pa_document pending)",
      },
    );
  }
  // Listing matches CMA, but PA side still unverified
  return dataMissing(
    "PC-20",
    `Listing Building_SqFt=${listingSqft} matches CMA median ${Math.round(cmaMedian)} within tolerance. PA-side sqft comparison still requires DocuSign envelope parse.`,
    {
      listing_sqft: listingSqft,
      cma_median_sqft: Math.round(cmaMedian),
      listing_vs_cma_variance_pct: listingVariance,
      pa_sqft: "data_missing",
      missing_data_source: "pa_document.sqft",
      recordId: ctx.recordId,
    },
  );
};

const PC_21_liens: CheckFn = (ctx) => {
  return dataMissing(
    "PC-21",
    "Phase 1: no lien data source wired. Future: title_prelim integration or county records.",
    {
      missing_data_source: "title_prelim_or_county_records",
      phase: 1,
      recordId: ctx.recordId,
    },
    "warn",
  );
};

const PC_22_recompute_math: CheckFn = (ctx) => {
  // Phase 1: uses CURRENT listing inputs (not PA-final). If current
  // inputs are missing or produce negative MAO, surface that signal.
  // Once DocuSign wires in, this check also compares against PA-final
  // numbers (which may differ if the seller-net deal includes closing-
  // cost shifts — the Briyana 5/12 pattern).
  const arv = ctx.listing?.realArvMedian;
  const rehab = ctx.listing?.estRehab;
  const yourMao = ctx.listing?.yourMao;
  const missing: string[] = [];
  if (arv == null || arv <= 0) missing.push("airtable_listing.Real_ARV_Median");
  if (rehab == null || rehab <= 0) missing.push("airtable_listing.Est_Rehab");
  if (missing.length > 0) {
    return dataMissing(
      "PC-22",
      `Pricing inputs incomplete (Real_ARV_Median + Est_Rehab required) — can't recompute. PA-final cross-reference also pending DocuSign.`,
      {
        missing_data_source: missing,
        your_mao_formula_output: yourMao,
        recordId: ctx.recordId,
        pa_final: "data_missing",
      },
    );
  }
  if (yourMao == null || yourMao <= 0) {
    return fail(
      "PC-22",
      `Your_MAO=$${yourMao?.toLocaleString() ?? "—"} on current inputs — spread negative or zero. Recompute with PA-final numbers (DocuSign) before signing.`,
      { your_mao: yourMao, real_arv_median: arv, est_rehab: rehab },
    );
  }
  return dataMissing(
    "PC-22",
    `Current-input Your_MAO=$${yourMao.toLocaleString()} is positive. PA-final recompute still requires DocuSign envelope to extract final sale price + EMD + closing-cost shifts.`,
    {
      your_mao_current: yourMao,
      real_arv_median: arv,
      est_rehab: rehab,
      pa_final: "data_missing",
      missing_data_source: "pa_document.sale_price + pa_document.closing_costs",
      recordId: ctx.recordId,
    },
  );
};

const PC_23_buyer_pipeline: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_CONTRACT_CONFIG;
  const zip = ctx.listing?.zip;
  const city = ctx.listing?.city;
  if (!zip && !city) {
    return dataMissing("PC-23", "listing zip + city both unset — can't filter buyer pipeline", {
      missing_data_source: "airtable_listing.Zip + airtable_listing.City",
      recordId: ctx.recordId,
    });
  }
  const buyers = ctx.buyerPipeline ?? [];
  if (buyers.length === 0) {
    return dataMissing("PC-23", "Buyer pipeline fetch returned 0 — can't evaluate match count", {
      missing_data_source: "buyer_pipeline",
      recordId: ctx.recordId,
    });
  }
  // Phase 1 match: active buyers whose preferred_cities contains the
  // listing's city OR Buyers table is keyed by city not ZIP. Future:
  // strict ZIP match once preferred_zip_codes is structured.
  const matching = buyers.filter((b) => {
    if (!b.buyerActiveFlag) return false;
    const prefs = (b.preferredCities ?? "").toLowerCase();
    return Boolean(
      (city && prefs.includes(city.toLowerCase())) ||
      (zip && prefs.includes(zip)),
    );
  });
  if (matching.length < c.buyer_pipeline_min_in_zip) {
    return fail(
      "PC-23",
      `Only ${matching.length} active buyer(s) match this listing (min ${c.buyer_pipeline_min_in_zip}). Disposition risk — surface to Alex before signing.`,
      {
        listing_city: city,
        listing_zip: zip,
        matching_count: matching.length,
        min_required: c.buyer_pipeline_min_in_zip,
        matched_buyer_ids: matching.map((b) => b.id),
      },
      "warn",
    );
  }
  return pass(
    "PC-23",
    `${matching.length} active buyer(s) match this listing — pipeline OK`,
    {
      listing_city: city,
      listing_zip: zip,
      matching_count: matching.length,
      matched_buyer_ids: matching.slice(0, 10).map((b) => b.id),
    },
    "warn",
  );
};

const PC_24_final_confidence: CheckFn = () => {
  // Phase 1: most upstream checks are DocuSign-pending. A meaningful
  // composite requires every PC item to fire real. Surface a clear
  // "do not sign" signal until DocuSign integration enables full
  // verification — that's the inviolable default for Pre-Contract.
  return dataMissing(
    "PC-24",
    "Phase 1: final confidence requires all upstream PC items to fire real. With DocuSign MCP not yet wired, the composite cannot produce a recommend_sign / human_review / stop signal. DEFAULT: do not sign any PA through this gate until Phase 2 lands.",
    {
      missing_data_source: "pa_document (upstream cascade)",
      phase: 1,
      decision: "do_not_sign_until_phase_2",
      phase_2_note: "Composite from PC-01..PC-23: ≥80 recommend_sign, 60-79 human_review, <60 STOP",
    },
  );
};

export const PRE_CONTRACT_CHECKS: Record<string, CheckFn> = {
  "PC-01": PC_01_pull_pa,
  "PC-02": PC_02_sale_price_matches,
  "PC-03": PC_03_buyer_entity,
  "PC-04": PC_04_cash_financing,
  "PC-05": PC_05_inspection_contingency,
  "PC-06": PC_06_inspection_period,
  "PC-07": PC_07_closing_date,
  "PC-08": PC_08_emd_escrow,
  "PC-09": PC_09_emd_amount,
  "PC-10": PC_10_possession,
  "PC-11": PC_11_lead_paint,
  "PC-12": PC_12_attachments,
  "PC-13": PC_13_no_blank_dollars,
  "PC-14": PC_14_pa_vs_thread,
  "PC-15": PC_15_state_assignment,
  "PC-16": PC_16_memphis_assignability,
  "PC-17": PC_17_pull_cma,
  "PC-18": PC_18_ownership_match,
  "PC-19": PC_19_title_prelim,
  "PC-20": PC_20_sqft_match,
  "PC-21": PC_21_liens,
  "PC-22": PC_22_recompute_math,
  "PC-23": PC_23_buyer_pipeline,
  "PC-24": PC_24_final_confidence,
};
