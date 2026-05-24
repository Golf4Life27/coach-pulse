// Pre-Outreach Gate (Gate 1) check functions — 14 items per
// AKB_Deal_Flow_Orchestrator_Spec §4.
//
// Every check is a pure function that consumes a pre-fetched GateContext
// + the gate's config object and returns a CheckResult. No I/O —
// gate-runner.ts handles all data fetches up front.
//
// data_missing semantics (per Alex 5/13 design note): when a check
// can't run because the required field is unset, return data_missing
// with reasoning that names the specific field. The morning brief
// will surface "Gate X item Y blocked on missing data Z for record W."

import preOutreachConfig from "@/lib/config/gates/pre_outreach.json";
import neverListConfig from "@/lib/config/never_list.json";
import type { CheckFn, CheckResult, ChecklistItem, Gate } from "./types";

// Re-export the gate definition for run-gate routes. The config-side
// structure of pre_outreach.json doubles as the in-code Gate.
export const PRE_OUTREACH_GATE: Gate = {
  id: preOutreachConfig.gate_id,
  stage_from: preOutreachConfig.stage_from as Gate["stage_from"],
  stage_to: preOutreachConfig.stage_to as Gate["stage_to"],
  items: preOutreachConfig.items as ChecklistItem[],
};

export const PRE_OUTREACH_CONFIG = preOutreachConfig.config as {
  mls_status_blocked: string[];
  restricted_states: string[];
  property_type_allowed: string[];
  toll_free_prefixes: string[];
  beds_min: number;
  sqft_min: number;
  sqft_max: number;
  list_price_min: number;
  list_price_max: number;
  flip_score_max: number;
  live_verification_max_age_hours: number;
  distress_dom_min: number;
  distress_price_drop_min: number;
};

const NEVER_LIST = neverListConfig.addresses as string[];

// ── Helpers ───────────────────────────────────────────────────────────

function pass(item_id: string, reasoning: string, data_examined: Record<string, unknown>, failure_action: ChecklistItem["failure_action"] = "block"): CheckResult {
  return { item_id, status: "pass", reasoning, data_examined, failure_action };
}

function fail(item_id: string, reasoning: string, data_examined: Record<string, unknown>, failure_action: ChecklistItem["failure_action"] = "block"): CheckResult {
  return { item_id, status: "fail", reasoning, data_examined, failure_action };
}

function warn(item_id: string, reasoning: string, data_examined: Record<string, unknown>): CheckResult {
  return { item_id, status: "warning", reasoning, data_examined, failure_action: "warn" };
}

function dataMissing(item_id: string, reasoning: string, data_examined: Record<string, unknown>, failure_action: ChecklistItem["failure_action"] = "block"): CheckResult {
  return { item_id, status: "data_missing", reasoning, data_examined, failure_action };
}

function normalizeAddress(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

// ── Checks ────────────────────────────────────────────────────────────

const PO_01_valid_mls_status: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_OUTREACH_CONFIG;
  const mls = ctx.listing?.mlsStatus;
  if (!mls) {
    return dataMissing("PO-01", "MLS_Status is unset on the listing", {
      missing_data_source: "airtable_listing.MLS_Status",
      recordId: ctx.recordId,
    });
  }
  const blocked = c.mls_status_blocked.find(
    (s) => s.toLowerCase() === mls.toLowerCase(),
  );
  if (blocked) {
    return fail("PO-01", `MLS_Status is "${mls}" (in blocked list)`, {
      mls_status: mls,
      blocked_list: c.mls_status_blocked,
    });
  }
  return pass("PO-01", `MLS_Status is "${mls}"`, { mls_status: mls });
};

const PO_02_live_status_active: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_OUTREACH_CONFIG;
  const status = ctx.listing?.liveStatus;
  const verifiedAt = ctx.listing?.lastVerified;
  if (!status) {
    return dataMissing("PO-02", "Live_Status is unset on the listing", {
      missing_data_source: "airtable_listing.Live_Status",
      recordId: ctx.recordId,
    });
  }
  if (status.toLowerCase() !== "active") {
    return fail("PO-02", `Live_Status is "${status}" — must be "Active"`, {
      live_status: status,
    });
  }
  if (!verifiedAt) {
    return dataMissing(
      "PO-02",
      "Live_Status is Active but Last_Verified is unset — can't confirm verification recency",
      {
        missing_data_source: "airtable_listing.Last_Verified",
        recordId: ctx.recordId,
      },
    );
  }
  const ageMs = Date.now() - new Date(verifiedAt).getTime();
  const ageHours = ageMs / (60 * 60_000);
  if (isNaN(ageHours)) {
    return dataMissing(
      "PO-02",
      `Last_Verified value "${verifiedAt}" did not parse as a date`,
      { last_verified: verifiedAt, recordId: ctx.recordId },
    );
  }
  if (ageHours > c.live_verification_max_age_hours) {
    return fail(
      "PO-02",
      `Last_Verified is ${ageHours.toFixed(1)}hr old (max ${c.live_verification_max_age_hours}hr)`,
      { last_verified: verifiedAt, age_hours: ageHours },
    );
  }
  return pass(
    "PO-02",
    `Live_Status=Active, verified ${ageHours.toFixed(1)}hr ago`,
    { live_status: status, age_hours: ageHours },
  );
};

const PO_03_not_off_market: CheckFn = (ctx) => {
  const omo = ctx.listing?.offMarketOverride;
  // Default false treated as pass — checkbox defaults are explicit-falsey
  if (omo === true) {
    return fail("PO-03", "Off_Market_Override is checked", { off_market_override: true });
  }
  return pass("PO-03", "Off_Market_Override is false", { off_market_override: omo ?? false });
};

const PO_04_not_on_never_list: CheckFn = (ctx) => {
  const addr = ctx.listing?.address;
  if (!addr) {
    return dataMissing("PO-04", "Address is unset on the listing", {
      missing_data_source: "airtable_listing.Address",
      recordId: ctx.recordId,
    });
  }
  const normalized = normalizeAddress(addr);
  const match = NEVER_LIST.find((entry) => normalizeAddress(entry) === normalized);
  if (match) {
    return fail("PO-04", `Address matches NEVER-list entry "${match}"`, {
      address: addr,
      matched_entry: match,
    });
  }
  return pass("PO-04", "Address not on NEVER-list", {
    address: addr,
    never_list_size: NEVER_LIST.length,
  });
};

const PO_05_state_not_restricted: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_OUTREACH_CONFIG;
  const state = ctx.listing?.state;
  if (!state) {
    return dataMissing("PO-05", "State is unset on the listing", {
      missing_data_source: "airtable_listing.State",
      recordId: ctx.recordId,
    });
  }
  const normalized = state.trim().toUpperCase();
  // Match either 2-letter or full-name forms against the allowlist of
  // restricted codes; per briefing the restricted set is codes only.
  if (c.restricted_states.includes(normalized)) {
    return fail("PO-05", `State "${state}" is in restricted_states`, {
      state,
      restricted_states: c.restricted_states,
    });
  }
  return pass("PO-05", `State "${state}" not restricted`, { state });
};

const PO_06_sfr_only: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_OUTREACH_CONFIG;
  const pt = ctx.listing?.propertyType;
  if (!pt) {
    return dataMissing("PO-06", "Property_Type is unset on the listing", {
      missing_data_source: "airtable_listing.Property_Type",
      recordId: ctx.recordId,
    });
  }
  const allowed = c.property_type_allowed.find(
    (s) => s.toLowerCase() === pt.toLowerCase(),
  );
  if (!allowed) {
    return fail(
      "PO-06",
      `Property_Type "${pt}" not in property_type_allowed`,
      { property_type: pt, allowed: c.property_type_allowed },
    );
  }
  return pass("PO-06", `Property_Type "${pt}" is allowed`, { property_type: pt });
};

const PO_07_min_beds: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_OUTREACH_CONFIG;
  const beds = ctx.listing?.bedrooms;
  if (beds == null) {
    return dataMissing("PO-07", "Bedrooms is unset on the listing", {
      missing_data_source: "airtable_listing.Bedrooms",
      recordId: ctx.recordId,
    });
  }
  if (beds < c.beds_min) {
    return fail("PO-07", `Bedrooms=${beds} (min ${c.beds_min})`, {
      bedrooms: beds,
      beds_min: c.beds_min,
    });
  }
  return pass("PO-07", `Bedrooms=${beds}`, { bedrooms: beds });
};

const PO_08_sqft_in_range: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_OUTREACH_CONFIG;
  const sqft = ctx.listing?.buildingSqFt;
  if (sqft == null) {
    return dataMissing("PO-08", "Building_SqFt is unset on the listing", {
      missing_data_source: "airtable_listing.Building_SqFt",
      recordId: ctx.recordId,
    });
  }
  if (sqft < c.sqft_min || sqft > c.sqft_max) {
    return fail(
      "PO-08",
      `Building_SqFt=${sqft} (allowed [${c.sqft_min}, ${c.sqft_max}])`,
      { sqft, sqft_min: c.sqft_min, sqft_max: c.sqft_max },
    );
  }
  return pass("PO-08", `Building_SqFt=${sqft}`, { sqft });
};

const PO_09_list_price_in_range: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_OUTREACH_CONFIG;
  const lp = ctx.listing?.listPrice;
  if (lp == null) {
    return dataMissing("PO-09", "List_Price is unset on the listing", {
      missing_data_source: "airtable_listing.List_Price",
      recordId: ctx.recordId,
    });
  }
  if (lp < c.list_price_min || lp > c.list_price_max) {
    return fail(
      "PO-09",
      `List_Price=$${lp.toLocaleString()} (allowed [$${c.list_price_min}, $${c.list_price_max}])`,
      { list_price: lp, list_price_min: c.list_price_min, list_price_max: c.list_price_max },
    );
  }
  return pass("PO-09", `List_Price=$${lp.toLocaleString()}`, { list_price: lp });
};

const PO_10_agent_phone_numeric: CheckFn = (ctx) => {
  const phone = ctx.listing?.agentPhone;
  if (!phone) {
    return dataMissing("PO-10", "Agent_Phone is unset on the listing", {
      missing_data_source: "airtable_listing.Agent_Phone",
      recordId: ctx.recordId,
    });
  }
  const digits = digitsOnly(phone);
  if (digits.length < 10) {
    return fail(
      "PO-10",
      `Agent_Phone "${phone}" has ${digits.length} digits (min 10)`,
      { agent_phone: phone, digit_count: digits.length },
    );
  }
  return pass("PO-10", `Agent_Phone has ${digits.length} digits`, {
    agent_phone: phone,
    digit_count: digits.length,
  });
};

const PO_11_not_toll_free: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_OUTREACH_CONFIG;
  const phone = ctx.listing?.agentPhone;
  if (!phone) {
    return dataMissing("PO-11", "Agent_Phone is unset on the listing", {
      missing_data_source: "airtable_listing.Agent_Phone",
      recordId: ctx.recordId,
    });
  }
  const digits = digitsOnly(phone);
  // Strip leading "1" country code if present, then check first 3 digits.
  const localDigits = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (localDigits.length < 3) {
    return dataMissing(
      "PO-11",
      `Agent_Phone "${phone}" has too few digits to determine area code`,
      { agent_phone: phone, digits },
    );
  }
  const areaCode = localDigits.slice(0, 3);
  if (c.toll_free_prefixes.includes(areaCode)) {
    return fail(
      "PO-11",
      `Agent_Phone area code ${areaCode} is toll-free (in ${c.toll_free_prefixes.join("/")})`,
      { agent_phone: phone, area_code: areaCode },
    );
  }
  return pass("PO-11", `Agent_Phone area code ${areaCode} not toll-free`, {
    agent_phone: phone,
    area_code: areaCode,
  });
};

const PO_12_flip_score_under_threshold: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_OUTREACH_CONFIG;
  // Null treated as 0 per pass_criteria — Flip_Score is keyword-detection
  // output, and absence of evidence is treated as not-flagged.
  const fs = ctx.listing?.flipScore ?? 0;
  if (fs >= c.flip_score_max) {
    return fail(
      "PO-12",
      `Flip_Score=${fs} (must be < ${c.flip_score_max} — Manual Review threshold)`,
      { flip_score: fs, flip_score_max: c.flip_score_max },
    );
  }
  return pass("PO-12", `Flip_Score=${fs}`, { flip_score: fs });
};

const PO_13_distress_signal: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_OUTREACH_CONFIG;
  const dom = ctx.listing?.dom;
  const drops = ctx.listing?.priceDropCount;
  // Spec: failure_action=warn. Missing data is treated as data_missing on
  // the warn track — surfaced in audit but doesn't block the gate.
  if (dom == null && drops == null) {
    return dataMissing(
      "PO-13",
      "Neither DOM_Calc_V2 nor Price_Drop_Count is set — can't compute distress signal",
      {
        missing_data_source: "airtable_listing.DOM_Calc_V2 + airtable_listing.Price_Drop_Count",
        recordId: ctx.recordId,
      },
      "warn",
    );
  }
  const domOk = (dom ?? 0) >= c.distress_dom_min;
  const dropsOk = (drops ?? 0) >= c.distress_price_drop_min;
  if (!domOk && !dropsOk) {
    return warn(
      "PO-13",
      `No distress signal — DOM=${dom ?? "—"} (need >=${c.distress_dom_min}) and Price_Drop_Count=${drops ?? "—"} (need >=${c.distress_price_drop_min})`,
      { dom, price_drop_count: drops, dom_min: c.distress_dom_min, drops_min: c.distress_price_drop_min },
    );
  }
  return pass(
    "PO-13",
    `Distress signal present — DOM=${dom ?? "—"}, Price_Drop_Count=${drops ?? "—"}`,
    { dom, price_drop_count: drops },
    "warn",
  );
};

const PO_14_do_not_text: CheckFn = (ctx) => {
  const dnt = ctx.listing?.doNotText;
  if (dnt === true) {
    return fail("PO-14", "Do_Not_Text is checked — outreach is manually disabled", {
      do_not_text: true,
    });
  }
  return pass("PO-14", "Do_Not_Text is false", { do_not_text: dnt ?? false });
};

export const PRE_OUTREACH_CHECKS: Record<string, CheckFn> = {
  "PO-01": PO_01_valid_mls_status,
  "PO-02": PO_02_live_status_active,
  "PO-03": PO_03_not_off_market,
  "PO-04": PO_04_not_on_never_list,
  "PO-05": PO_05_state_not_restricted,
  "PO-06": PO_06_sfr_only,
  "PO-07": PO_07_min_beds,
  "PO-08": PO_08_sqft_in_range,
  "PO-09": PO_09_list_price_in_range,
  "PO-10": PO_10_agent_phone_numeric,
  "PO-11": PO_11_not_toll_free,
  "PO-12": PO_12_flip_score_under_threshold,
  "PO-13": PO_13_distress_signal,
  "PO-14": PO_14_do_not_text,
};
