// Pre-Send Gate (Gate 2) check functions — 12 items per
// AKB_Deal_Flow_Orchestrator_Spec §4.
//
// This gate is the last filter before SMS fires. It replaces the H2
// Make-scenario filter logic once Acquisition Agent ships, so the
// checks here mirror H2's existing gates (Approved_For_Outreach,
// Outreach_Status empty, send-window) plus the pricing-readiness items
// (PS-01..PS-06) that lean on the Pricing Agent's outputs.
//
// Working-assumption calls flagged in pass_criteria strings:
//
//   PS-01: "Pricing Agent has run within 24hr" → proxy via
//          ARV_Validated_At timestamp on the listing. Pricing Agent
//          stamps it on success; cheaper than per-record audit-log query.
//
//   PS-05: "Confidence_Score ≥ 60" — spec doesn't name which confidence.
//          Using Rehab_Confidence_Score (numeric 0-100, schema-confirmed).
//          Re-key in config + check if a composite is needed later.
//
//   PS-08: "Last SMS to this agent within 14d" — true cross-listing
//          scan is expensive. Checking THIS listing's Last_Outbound_At
//          here. H2's existing dedupe handles cross-listing; future
//          gate revision can add the cross-listing scan when warranted.
//
//   PS-12: Quo health — env-present check + last quo:send_attempt audit
//          within configurable window must be confirmed_success (or no
//          entry in window — treat as healthy/unknown).

import preSendConfig from "@/lib/config/gates/pre_send.json";
import type { CheckFn, CheckResult, ChecklistItem, Gate } from "./types";

export const PRE_SEND_GATE: Gate = {
  id: preSendConfig.gate_id,
  stage_from: preSendConfig.stage_from as Gate["stage_from"],
  stage_to: preSendConfig.stage_to as Gate["stage_to"],
  items: preSendConfig.items as ChecklistItem[],
};

export const PRE_SEND_CONFIG = preSendConfig.config as {
  pricing_agent_max_age_hours: number;
  confidence_min: number;
  spread_min_usd: number;
  send_window_start_hour: number;
  send_window_end_hour: number;
  send_window_timezone: string;
  agent_recontact_days: number;
  outreach_status_empty_values: string[];
  execution_path_auto_proceed_values: string[];
  quo_health_audit_max_age_minutes: number;
};

// ── Helpers (duplicated from pre-outreach-checks deliberately — keeping
//     each gate file self-contained. Move to a shared module when a
//     third gate lands and the duplication actually costs something.) ──

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

// Hours-since-timestamp helper. Returns Infinity if parse fails (treats
// as ancient/missing) so callers can branch on "older than threshold."
function hoursSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / (60 * 60_000);
}

// Get the hour-of-day (0-23) in a specific IANA timezone.
function hourInTimezone(timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === "hour");
  return hourPart ? parseInt(hourPart.value, 10) : NaN;
}

// ── Checks ────────────────────────────────────────────────────────────

const PS_01_pricing_agent_recent: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_SEND_CONFIG;
  const ts = ctx.listing?.arvValidatedAt;
  if (!ts) {
    return dataMissing(
      "PS-01",
      "ARV_Validated_At is unset — Pricing Agent has not run on this record (or run failed)",
      {
        missing_data_source: "airtable_listing.ARV_Validated_At",
        recordId: ctx.recordId,
      },
    );
  }
  const ageHours = hoursSince(ts);
  if (ageHours > c.pricing_agent_max_age_hours) {
    return fail(
      "PS-01",
      `Pricing Agent last ran ${ageHours.toFixed(1)}hr ago (max ${c.pricing_agent_max_age_hours}hr)`,
      { arv_validated_at: ts, age_hours: ageHours, max_age_hours: c.pricing_agent_max_age_hours },
    );
  }
  return pass("PS-01", `Pricing Agent ran ${ageHours.toFixed(1)}hr ago`, {
    arv_validated_at: ts,
    age_hours: ageHours,
  });
};

const PS_02_arv_present: CheckFn = (ctx) => {
  const arv = ctx.listing?.realArvMedian;
  if (arv == null) {
    return dataMissing("PS-02", "Real_ARV_Median is unset on the listing", {
      missing_data_source: "airtable_listing.Real_ARV_Median",
      recordId: ctx.recordId,
    });
  }
  if (arv <= 0) {
    return fail("PS-02", `Real_ARV_Median=$${arv.toLocaleString()} (must be > 0)`, { arv });
  }
  return pass("PS-02", `Real_ARV_Median=$${arv.toLocaleString()}`, { arv });
};

const PS_03_rehab_present: CheckFn = (ctx) => {
  const rehab = ctx.listing?.estRehabMid;
  if (rehab == null) {
    return dataMissing("PS-03", "Est_Rehab_Mid is unset on the listing", {
      missing_data_source: "airtable_listing.Est_Rehab_Mid",
      recordId: ctx.recordId,
    });
  }
  if (rehab <= 0) {
    return fail("PS-03", `Est_Rehab_Mid=$${rehab.toLocaleString()} (must be > 0)`, { rehab });
  }
  return pass("PS-03", `Est_Rehab_Mid=$${rehab.toLocaleString()}`, { rehab });
};

const PS_04_your_mao_positive: CheckFn = (ctx) => {
  const mao = ctx.listing?.yourMao;
  if (mao == null) {
    return dataMissing("PS-04", "Your_MAO is unset on the listing", {
      missing_data_source: "airtable_listing.Your_MAO",
      recordId: ctx.recordId,
    });
  }
  if (mao <= 0) {
    return fail("PS-04", `Your_MAO=$${mao.toLocaleString()} (must be > 0)`, { your_mao: mao });
  }
  return pass("PS-04", `Your_MAO=$${mao.toLocaleString()}`, { your_mao: mao });
};

const PS_05_confidence: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_SEND_CONFIG;
  // Working assumption: Rehab_Confidence_Score is the numeric 0-100
  // value the spec's "Confidence_Score ≥ 60" applies to. ARV_Confidence
  // is categorical (High/Medium/Low) and doesn't map cleanly to the
  // threshold check.
  const score = ctx.listing?.rehabConfidenceScore;
  if (score == null) {
    return dataMissing("PS-05", "Rehab_Confidence_Score is unset on the listing", {
      missing_data_source: "airtable_listing.Rehab_Confidence_Score",
      recordId: ctx.recordId,
      working_assumption: "Using Rehab_Confidence_Score as the canonical confidence per check fn header",
    });
  }
  if (score < c.confidence_min) {
    return fail(
      "PS-05",
      `Rehab_Confidence_Score=${score} (min ${c.confidence_min}) — Hold per spec`,
      { confidence_score: score, confidence_min: c.confidence_min },
    );
  }
  return pass("PS-05", `Rehab_Confidence_Score=${score}`, { confidence_score: score });
};

const PS_06_spread: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_SEND_CONFIG;
  const investor = ctx.listing?.investorMao;
  const your = ctx.listing?.yourMao;
  if (investor == null || your == null) {
    return dataMissing(
      "PS-06",
      "Investor_MAO or Your_MAO unset on the listing — can't compute spread",
      {
        missing_data_source: investor == null
          ? "airtable_listing.Investor_MAO"
          : "airtable_listing.Your_MAO",
        recordId: ctx.recordId,
        investor_mao: investor,
        your_mao: your,
      },
    );
  }
  // Sanity: both inputs must be positive before the spread check is
  // meaningful. Without this gate, negative inputs (e.g. Your_MAO=-45K,
  // Investor_MAO=-30K → spread=$15K) pass the threshold despite both
  // being nonsense values. PS-04 already catches negative Your_MAO; this
  // belt-and-suspenders the spread check itself.
  if (investor <= 0 || your <= 0) {
    return fail(
      "PS-06",
      `Spread calc requires positive inputs — Investor_MAO=$${investor.toLocaleString()}, Your_MAO=$${your.toLocaleString()}`,
      { investor_mao: investor, your_mao: your },
    );
  }
  const spread = investor - your;
  if (spread < c.spread_min_usd) {
    return fail(
      "PS-06",
      `Spread=$${spread.toLocaleString()} (min $${c.spread_min_usd.toLocaleString()})`,
      { spread, investor_mao: investor, your_mao: your, spread_min: c.spread_min_usd },
    );
  }
  return pass("PS-06", `Spread=$${spread.toLocaleString()}`, {
    spread,
    investor_mao: investor,
    your_mao: your,
  });
};

const PS_07_send_window: CheckFn = (_ctx, cfg) => {
  const c = cfg as typeof PRE_SEND_CONFIG;
  const hour = hourInTimezone(c.send_window_timezone);
  if (isNaN(hour)) {
    return dataMissing(
      "PS-07",
      `Could not resolve current hour in timezone "${c.send_window_timezone}"`,
      { timezone: c.send_window_timezone },
    );
  }
  const inWindow = hour >= c.send_window_start_hour && hour < c.send_window_end_hour;
  if (!inWindow) {
    return fail(
      "PS-07",
      `Outside send window — current hour ${hour} in ${c.send_window_timezone} (allowed ${c.send_window_start_hour}-${c.send_window_end_hour})`,
      {
        current_hour: hour,
        timezone: c.send_window_timezone,
        window_start: c.send_window_start_hour,
        window_end: c.send_window_end_hour,
      },
    );
  }
  return pass(
    "PS-07",
    `In send window — hour ${hour} ${c.send_window_timezone}`,
    { current_hour: hour, timezone: c.send_window_timezone },
  );
};

const PS_08_no_recent_text: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_SEND_CONFIG;
  // Per-listing only — cross-listing agent scan is future work, see file header.
  const lastOut = ctx.listing?.lastOutboundAt;
  if (!lastOut) {
    return pass("PS-08", "No prior outbound on this listing", {
      last_outbound_at: null,
      cross_listing_scan: "not_implemented",
    });
  }
  const ageHours = hoursSince(lastOut);
  const ageDays = ageHours / 24;
  if (ageDays < c.agent_recontact_days) {
    return warn(
      "PS-08",
      `Last_Outbound_At was ${ageDays.toFixed(1)}d ago — within ${c.agent_recontact_days}d recontact window`,
      {
        last_outbound_at: lastOut,
        age_days: ageDays,
        recontact_window_days: c.agent_recontact_days,
        cross_listing_scan: "not_implemented",
      },
    );
  }
  return pass(
    "PS-08",
    `Last_Outbound_At was ${ageDays.toFixed(1)}d ago — outside ${c.agent_recontact_days}d window`,
    { last_outbound_at: lastOut, age_days: ageDays },
  );
};

const PS_09_script_route: CheckFn = (ctx) => {
  // Always informational pass — surfaces routing decision in data_examined.
  const count = ctx.listing?.agentPriorOutreachCount ?? 0;
  const route = count > 0 ? "repeat_agent" : "first_touch";
  return pass(
    "PS-09",
    `Script route: ${route} (Agent_Prior_Outreach_Count=${count})`,
    { agent_prior_outreach_count: count, script_route: route },
    "warn",
  );
};

const PS_10_approved_or_auto: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_SEND_CONFIG;
  const approved = ctx.listing?.approvedForOutreach === true;
  const execPath = ctx.listing?.executionPath;
  const autoProceed = execPath != null && c.execution_path_auto_proceed_values.includes(execPath);
  if (!approved && !autoProceed) {
    return fail(
      "PS-10",
      `Neither Approved_For_Outreach nor Execution_Path=Auto Proceed (approved=${approved}, execution_path="${execPath ?? "—"}")`,
      {
        approved_for_outreach: approved,
        execution_path: execPath,
        execution_path_auto_proceed_values: c.execution_path_auto_proceed_values,
      },
    );
  }
  return pass(
    "PS-10",
    `Outreach approved (approved=${approved}, auto_proceed=${autoProceed})`,
    {
      approved_for_outreach: approved,
      execution_path: execPath,
      via: approved ? "approved_for_outreach" : "execution_path_auto_proceed",
    },
  );
};

const PS_11_outreach_status_empty: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_SEND_CONFIG;
  const status = ctx.listing?.outreachStatus ?? "";
  const isEmpty = status === "" || c.outreach_status_empty_values
    .map((s) => s.toLowerCase())
    .includes(status.toLowerCase());
  if (!isEmpty) {
    return fail(
      "PS-11",
      `Outreach_Status is "${status}" — already contacted (pre-send blocks re-firing)`,
      { outreach_status: status, empty_values: c.outreach_status_empty_values },
    );
  }
  return pass("PS-11", `Outreach_Status is empty ("${status}")`, {
    outreach_status: status,
  });
};

const PS_12_quo_healthy: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_SEND_CONFIG;
  // Env-presence check happens lambda-side (we can't read process.env
  // from a pure check function safely). Audit-log inference proxies it:
  // if no quo audit entries exist at all in the recent window, AND env
  // is set (gate-runner sets a flag we can read), treat as healthy.
  //
  // Practical signal: the most-recent quo:send_attempt within window
  // determines health.
  //   - last in window was confirmed_success → healthy
  //   - last in window was confirmed_failure → unhealthy (block)
  //   - last in window was uncertain → unhealthy proxy (block)
  //   - no entries in window → unknown; treat as healthy (don't block
  //     on absence of evidence — Quo may simply not have been used yet)
  const entries = ctx.auditLog ?? [];
  const cutoffMs = Date.now() - c.quo_health_audit_max_age_minutes * 60_000;
  const recent = entries
    .filter((e) => e.agent === "quo" && e.event === "send_attempt")
    .filter((e) => new Date(e.ts).getTime() >= cutoffMs)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  if (recent.length === 0) {
    return pass(
      "PS-12",
      `No Quo audit entries in last ${c.quo_health_audit_max_age_minutes}min — treating as healthy (absence of evidence)`,
      {
        quo_recent_count: 0,
        window_minutes: c.quo_health_audit_max_age_minutes,
        inference: "absence_of_evidence_is_not_evidence_of_failure",
      },
    );
  }
  const last = recent[0];
  if (last.status === "confirmed_success") {
    return pass(
      "PS-12",
      `Most-recent Quo send was confirmed_success ${Math.round((Date.now() - new Date(last.ts).getTime()) / 60_000)}min ago`,
      {
        last_quo_send_ts: last.ts,
        last_quo_send_status: last.status,
        last_quo_message_id: last.externalId,
      },
    );
  }
  return fail(
    "PS-12",
    `Most-recent Quo send was ${last.status} — Quo health uncertain or failing`,
    {
      last_quo_send_ts: last.ts,
      last_quo_send_status: last.status,
      last_quo_error: last.error,
    },
  );
};

export const PRE_SEND_CHECKS: Record<string, CheckFn> = {
  "PS-01": PS_01_pricing_agent_recent,
  "PS-02": PS_02_arv_present,
  "PS-03": PS_03_rehab_present,
  "PS-04": PS_04_your_mao_positive,
  "PS-05": PS_05_confidence,
  "PS-06": PS_06_spread,
  "PS-07": PS_07_send_window,
  "PS-08": PS_08_no_recent_text,
  "PS-09": PS_09_script_route,
  "PS-10": PS_10_approved_or_auto,
  "PS-11": PS_11_outreach_status_empty,
  "PS-12": PS_12_quo_healthy,
};
