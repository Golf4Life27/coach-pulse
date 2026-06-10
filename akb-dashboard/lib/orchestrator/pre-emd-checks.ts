// Pre-EMD DD Gate (Gate 5, INV-029) check functions.
//
// Runs while a deal is under_contract, BEFORE the operator wires EMD.
// All 7 items blocking — the gate returns BLOCKED with itemized reasons
// until every item passes. The EMD action button (Forge ship, downstream)
// reads this gate's output and stays disabled until green; this ship does
// NOT build the button.
//
// Field decisions locked 2026-05-25:
//   PE-01 CMA staleness  → Listing.arvValidatedAt (7-day threshold)
//   PE-02 Buyer_Median   → Property_Intel.Buyer_Median_Value (INV-022)
//   PE-03 Federation     → Property_Intel.Discrepancy_Severity_Max
//   PE-04 Memphis verify → Listing.memphisAssignmentVerified (new checkbox)
//   PE-05 Buyer-track MAO→ Listing.investorMao
//   PE-06 Sturtevant     → photo-rehab presence + sqft variance ≤50%
//   PE-07 Operator signoff→ Listing.emdOperatorSignoff (new checkbox)

import preEmdConfig from "@/lib/config/gates/pre_emd.json";
import type { CheckFn, CheckResult, ChecklistItem, Gate } from "./types";

export const PRE_EMD_GATE: Gate = {
  id: preEmdConfig.gate_id,
  stage_from: preEmdConfig.stage_from as Gate["stage_from"],
  stage_to: preEmdConfig.stage_to as Gate["stage_to"],
  items: preEmdConfig.items as ChecklistItem[],
};

export const PRE_EMD_CONFIG = preEmdConfig.config as {
  cma_staleness_days: number;
  condition_variance_block_pct: number;
};

// ── Helpers ───────────────────────────────────────────────────────────

function pass(item_id: string, reasoning: string, data_examined: Record<string, unknown>): CheckResult {
  return { item_id, status: "pass", reasoning, data_examined, failure_action: "block" };
}
function fail(item_id: string, reasoning: string, data_examined: Record<string, unknown>): CheckResult {
  return { item_id, status: "fail", reasoning, data_examined, failure_action: "block" };
}
function dataMissing(item_id: string, reasoning: string, data_examined: Record<string, unknown>): CheckResult {
  return { item_id, status: "data_missing", reasoning, data_examined, failure_action: "block" };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

const DAY_MS = 86_400_000;

// ── Checks ────────────────────────────────────────────────────────────

const PE_01_cma_fresh: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_EMD_CONFIG;
  const validatedAt = ctx.listing?.arvValidatedAt ?? null;
  const cma = ctx.cma;
  if (!validatedAt) {
    return fail("PE-01", "CMA absent — Listing.arvValidatedAt is unset (comps never validated).", {
      arv_validated_at: null,
      recordId: ctx.recordId,
    });
  }
  const t = Date.parse(validatedAt);
  if (Number.isNaN(t)) {
    return fail("PE-01", `CMA timestamp unparseable: "${validatedAt}".`, {
      arv_validated_at: validatedAt,
      recordId: ctx.recordId,
    });
  }
  const ageDays = (Date.now() - t) / DAY_MS;
  if (ageDays > c.cma_staleness_days) {
    return fail(
      "PE-01",
      `CMA stale — validated ${ageDays.toFixed(1)}d ago (>${c.cma_staleness_days}d threshold). Re-run ARV before EMD.`,
      { arv_validated_at: validatedAt, age_days: Number(ageDays.toFixed(1)), threshold_days: c.cma_staleness_days },
    );
  }
  if (cma == null) {
    return dataMissing("PE-01", "CMA fetch failed (RentCast source error).", {
      missing_data_source: "cma",
      recordId: ctx.recordId,
    });
  }
  if (cma.length === 0) {
    return fail("PE-01", "RentCast returned 0 comparables — CMA empty.", { comp_count: 0 });
  }
  return pass("PE-01", `CMA fresh (validated ${ageDays.toFixed(1)}d ago, ${cma.length} comps).`, {
    arv_validated_at: validatedAt,
    age_days: Number(ageDays.toFixed(1)),
    comp_count: cma.length,
  });
};

const PE_02_buyer_median: CheckFn = (ctx) => {
  const pi = ctx.propertyIntel;
  if (!pi) {
    return fail("PE-02", "Buyer_Median absent — no Property_Intel row for this record (federation not run).", {
      property_intel: null,
      recordId: ctx.recordId,
    });
  }
  const bm = pi.buyerMedianValue;
  if (bm == null || bm <= 0) {
    return fail(
      "PE-02",
      "Buyer_Median absent — Property_Intel.Buyer_Median_Value is null/≤0. V2.1 floor truth signal missing (Decision Preconditions Rule 1).",
      { buyer_median_value: bm, hydration_status: pi.hydrationStatus, recordId: ctx.recordId },
    );
  }
  return pass("PE-02", `Buyer_Median present: $${bm.toLocaleString()}.`, {
    buyer_median_value: bm,
    hydration_status: pi.hydrationStatus,
  });
};

const PE_03_federation_green: CheckFn = (ctx) => {
  const pi = ctx.propertyIntel;
  if (!pi) {
    return fail("PE-03", "Federation status unknown — no Property_Intel row (federation not run).", {
      property_intel: null,
      recordId: ctx.recordId,
    });
  }
  const sev = (pi.discrepancySeverityMax ?? "").toLowerCase();
  if (sev === "amber" || sev === "red") {
    return fail(
      "PE-03",
      `Federation surfaced a ${sev.toUpperCase()} discrepancy — resolve before EMD (see Property_Intel.Discrepancy_Flags_JSON).`,
      { discrepancy_severity_max: pi.discrepancySeverityMax, recordId: ctx.recordId },
    );
  }
  if (sev === "" || (sev !== "none" && sev !== "info")) {
    return fail("PE-03", `Federation severity unset/unrecognized ("${pi.discrepancySeverityMax}") — treat as not-green.`, {
      discrepancy_severity_max: pi.discrepancySeverityMax,
      recordId: ctx.recordId,
    });
  }
  return pass("PE-03", `Federation green (severity=${sev}).`, {
    discrepancy_severity_max: pi.discrepancySeverityMax,
  });
};

const PE_04_assignment_clause: CheckFn = (ctx) => {
  // Operator ruling 2026-06-10: REQUIRED FOR EVERY STATE. Memphis is where
  // we learned the lesson, not the boundary of the risk — a Michigan PA can
  // carry non-assignability language too. Reads the DEAL (one concept, one
  // table), not the listing.
  if (!ctx.deal) {
    return dataMissing("PE-04", "No Deals row joined to this listing — assignment-clause attestation lives on the deal.", {
      missing_data_source: "airtable_deal",
      recordId: ctx.recordId,
    });
  }
  if (ctx.deal.preEmdAssignmentClauseVerified !== true) {
    return fail(
      "PE-04",
      "Pre_EMD_Assignment_Clause_Verified is not set. Operator must confirm assignment is not prohibited in THIS contract (every state, always) before EMD.",
      { state: ctx.listing?.state ?? null, pre_emd_assignment_clause_verified: false, deal_record_id: ctx.deal.dealRecordId },
    );
  }
  return pass("PE-04", "Pre_EMD_Assignment_Clause_Verified=true (operator confirmed assignment not prohibited).", {
    state: ctx.listing?.state ?? null,
    pre_emd_assignment_clause_verified: true,
    deal_record_id: ctx.deal.dealRecordId,
  });
};

const PE_05_buyer_track_mao: CheckFn = (ctx) => {
  const mao = ctx.listing?.investorMao ?? null;
  if (mao == null || mao <= 0) {
    return fail(
      "PE-05",
      `Buyer-track MAO not computed (Listing.investorMao=${mao ?? "null"}). Pricing math incomplete.`,
      { investor_mao: mao, recordId: ctx.recordId },
    );
  }
  return pass("PE-05", `Buyer-track MAO computed: $${mao.toLocaleString()}.`, { investor_mao: mao });
};

const PE_06_photos_vs_modeled: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_EMD_CONFIG;
  // Half 1: photos must have been verified at all (a rehab exists on record).
  if (!ctx.listing?.rehabEstimatedAt) {
    return fail(
      "PE-06",
      "Photos not verified against condition — no rehab estimate on record (vision/manual rehab never ran).",
      { rehab_estimated_at: null, recordId: ctx.recordId },
    );
  }
  // Half 2: modeled-vs-evidenced footprint variance (Sturtevant primitive,
  // PC-20 pattern) at the 50% block threshold.
  const listingSqft = ctx.listing?.buildingSqFt ?? null;
  const compSqfts = (ctx.cma ?? [])
    .map((cp) => cp.squareFootage)
    .filter((s): s is number => s != null && s > 0);
  if (listingSqft == null || listingSqft <= 0) {
    return dataMissing("PE-06", "listing.buildingSqFt unset — can't compute condition variance.", {
      missing_data_source: "airtable_listing.Building_SqFt",
      recordId: ctx.recordId,
    });
  }
  if (compSqfts.length === 0) {
    return dataMissing("PE-06", "No CMA comps with sqft — can't compute modeled-vs-evidenced variance.", {
      missing_data_source: "cma[].squareFootage",
      recordId: ctx.recordId,
    });
  }
  const cmaMedian = median(compSqfts)!;
  const variance = Math.abs(listingSqft - cmaMedian) / cmaMedian;
  if (variance > c.condition_variance_block_pct) {
    return fail(
      "PE-06",
      `Modeled-vs-evidenced footprint variance ${(variance * 100).toFixed(0)}% (>${(c.condition_variance_block_pct * 100).toFixed(0)}% Sturtevant block). Listing sqft=${listingSqft} vs CMA median ${Math.round(cmaMedian)}.`,
      {
        listing_sqft: listingSqft,
        cma_median_sqft: Math.round(cmaMedian),
        variance_pct: Number((variance * 100).toFixed(1)),
        threshold_pct: c.condition_variance_block_pct * 100,
        rehab_source: ctx.listing?.rehabSource ?? null,
      },
    );
  }
  return pass(
    "PE-06",
    `Photos verified (rehab on record) and footprint variance ${(variance * 100).toFixed(0)}% within tolerance.`,
    {
      listing_sqft: listingSqft,
      cma_median_sqft: Math.round(cmaMedian),
      variance_pct: Number((variance * 100).toFixed(1)),
      rehab_source: ctx.listing?.rehabSource ?? null,
    },
  );
};

const PE_07_operator_signoff: CheckFn = (ctx) => {
  // Reads the DEAL (2026-06-10 move off Listings_V1).
  if (!ctx.deal) {
    return dataMissing("PE-07", "No Deals row joined to this listing — operator sign-off lives on the deal.", {
      missing_data_source: "airtable_deal",
      recordId: ctx.recordId,
    });
  }
  if (ctx.deal.preEmdOperatorSignoff !== true) {
    return fail(
      "PE-07",
      "Pre_EMD_Operator_Signoff not set — final operator sign-off required before EMD wire (Lost-Phone Test).",
      { pre_emd_operator_signoff: false, deal_record_id: ctx.deal.dealRecordId, recordId: ctx.recordId },
    );
  }
  return pass("PE-07", "Pre_EMD_Operator_Signoff=true.", { pre_emd_operator_signoff: true, deal_record_id: ctx.deal.dealRecordId });
};

export const PRE_EMD_CHECKS: Record<string, CheckFn> = {
  "PE-01": PE_01_cma_fresh,
  "PE-02": PE_02_buyer_median,
  "PE-03": PE_03_federation_green,
  "PE-04": PE_04_assignment_clause,
  "PE-05": PE_05_buyer_track_mao,
  "PE-06": PE_06_photos_vs_modeled,
  "PE-07": PE_07_operator_signoff,
};
