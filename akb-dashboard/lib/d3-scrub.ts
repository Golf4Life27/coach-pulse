// D3 Phase 0a — Cheap pre-flight scrub for Outreach_Status = "Texted"
// records, classifies into 7 buckets so the follow-up cadence never
// fires against records that should be dead or off-limits.
//
// Per Alex 5/13 D3 directive §3:
//   a. Active confirmed         → eligible for standard follow_up cadence
//   b. Off-market confirmed     → Pipeline_Stage=dead + Live_Status=Off Market
//   c. Ambiguous                → status_check class (one-shot question)
//   d. Restricted state         → Do_Not_Text=true
//   e. NEVER-list match         → Do_Not_Text=true
//   f. Pipeline-stage advanced  → skip
//   g. Invalid phone format     → skip
//
// Phase 0a (this build) uses Airtable-only signals — cheap classification
// from Live_Status + Last_Verified age. Records that can't be cleanly
// classified from cached fields go into pending_reverification, which
// next turn either gets live re-scrape OR routes to status_check.
//
// Dry-run by default. Writes are gated on explicit `apply=true` param so
// Alex sees the bucket counts before any Pipeline_Stage / Do_Not_Text
// mutations land.

import type { Listing } from "@/lib/types";
import preOutreachConfig from "@/lib/config/gates/pre_outreach.json";
import neverListConfig from "@/lib/config/never_list.json";

// Buckets are mutually exclusive — each record lands in exactly one.
// Order of precedence matters: NEVER-list and restricted-state are
// inviolable (Briefing §3), so they're checked first regardless of
// Live_Status. Pipeline-active is checked next so records that moved
// on don't get scrubbed retroactively. Then the live-status-derived
// active / off_market / ambiguous classification.
export type ScrubBucket =
  | "active_eligible"
  | "off_market_killed"
  | "pending_reverification"
  | "skip_restricted_state"
  | "skip_never_list"
  | "skip_pipeline_active"
  | "skip_invalid_phone";

export interface ScrubResult {
  recordId: string;
  bucket: ScrubBucket;
  reasoning: string;
  data_examined: Record<string, unknown>;
  // Pending action — what would be written if apply=true. Phase 0a
  // surfaces this WITHOUT executing so dry-run is meaningful.
  pending_writes: Record<string, unknown> | null;
}

const RESTRICTED_STATES = new Set(
  preOutreachConfig.config.restricted_states.map((s) => s.toUpperCase()),
);

// Bare access — never_list.json carries the inviolable address allowlist.
// Currently empty (5/13). Alex's directive references "12 known from
// Bible v3" — those need to be populated before fire. Scrub will surface
// "NEVER-list empty (0 entries)" in the report so this is visible.
const NEVER_LIST: string[] = (neverListConfig.addresses as string[]).map((a) =>
  normalizeAddress(a),
);

function normalizeAddress(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

// Pipeline_Stage values that mean "this record has moved past Texted —
// scrub should leave it alone."
const PIPELINE_ACTIVE_STAGES = new Set([
  "negotiating",
  "offer_drafted",
  "under_contract",
  "dispo_active",
  "assignment_signed",
  "closed",
  "dead",
]);

// Live_Status string forms that indicate the listing is off-market.
const OFF_MARKET_STATUSES = new Set(["off market", "off-market", "sold", "pending", "withdrawn"]);

const FRESH_VERIFICATION_HOURS = preOutreachConfig.config.live_verification_max_age_hours; // 72

function hoursSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / (60 * 60_000);
}

/**
 * Classify a single Texted record. Pure function — no I/O, no Airtable
 * writes. Caller decides whether to apply pending_writes based on
 * dry-run flag.
 */
export function classifyTexted(listing: Listing): ScrubResult {
  const recordId = listing.id;

  // Precedence: inviolable rules first (Briefing §3 + spec §7).
  if (listing.state) {
    const stateUpper = listing.state.trim().toUpperCase();
    if (RESTRICTED_STATES.has(stateUpper)) {
      return {
        recordId,
        bucket: "skip_restricted_state",
        reasoning: `state="${listing.state}" in restricted_states (IL/MO/SC/NC/OK/ND). Inviolable per Briefing §3. Set Do_Not_Text=true.`,
        data_examined: {
          state: listing.state,
          restricted_states: preOutreachConfig.config.restricted_states,
        },
        pending_writes: { Do_Not_Text: true },
      };
    }
  }

  if (listing.address && NEVER_LIST.includes(normalizeAddress(listing.address))) {
    return {
      recordId,
      bucket: "skip_never_list",
      reasoning: `Address on NEVER-list. Inviolable per Briefing §3. Set Do_Not_Text=true.`,
      data_examined: { address: listing.address, never_list_size: NEVER_LIST.length },
      pending_writes: { Do_Not_Text: true },
    };
  }

  // Pipeline already advanced — leave alone.
  const stage = (listing.pipelineStage ?? "").toLowerCase();
  if (PIPELINE_ACTIVE_STAGES.has(stage)) {
    return {
      recordId,
      bucket: "skip_pipeline_active",
      reasoning: `Pipeline_Stage="${stage}" — record already advanced past Texted. Scrub leaves it alone.`,
      data_examined: { pipeline_stage: stage },
      pending_writes: null,
    };
  }

  // Phone format check
  const phone = listing.agentPhone ?? "";
  const phoneDigits = digitsOnly(phone);
  if (phoneDigits.length < 10) {
    return {
      recordId,
      bucket: "skip_invalid_phone",
      reasoning: `Agent_Phone="${phone}" has ${phoneDigits.length} digits — invalid for SMS. Skip; surface for manual fix.`,
      data_examined: { agent_phone: phone, digit_count: phoneDigits.length },
      pending_writes: null,
    };
  }

  // Live-status classification (cheap Airtable-derived).
  const live = (listing.liveStatus ?? "").toLowerCase().trim();
  const offMktOverride = listing.offMarketOverride === true;
  const verifiedAge = hoursSince(listing.lastVerified);

  if (offMktOverride || OFF_MARKET_STATUSES.has(live)) {
    return {
      recordId,
      bucket: "off_market_killed",
      reasoning: `Live_Status="${listing.liveStatus ?? "—"}"${offMktOverride ? " + Off_Market_Override=true" : ""}. Confirmed off-market post-intake. Pipeline_Stage→dead, Live_Status→"Off Market".`,
      data_examined: {
        live_status: listing.liveStatus,
        off_market_override: offMktOverride,
        last_verified: listing.lastVerified,
      },
      pending_writes: {
        Pipeline_Stage: "dead",
        Live_Status: "Off Market",
      },
    };
  }

  if (live === "active" && verifiedAge <= FRESH_VERIFICATION_HOURS) {
    return {
      recordId,
      bucket: "active_eligible",
      reasoning: `Live_Status=Active, Last_Verified ${verifiedAge.toFixed(1)}hr ago (<${FRESH_VERIFICATION_HOURS}hr). Eligible for follow_up cadence.`,
      data_examined: {
        live_status: listing.liveStatus,
        last_verified: listing.lastVerified,
        age_hours: verifiedAge,
      },
      pending_writes: null,
    };
  }

  // Live_Status unset, stale, or Active-but-verified->72hr ago.
  return {
    recordId,
    bucket: "pending_reverification",
    reasoning: `Live_Status="${listing.liveStatus ?? "unset"}", Last_Verified ${isFinite(verifiedAge) ? `${verifiedAge.toFixed(1)}hr ago` : "never"}. Can't confirm Active or Off_Market from cached data. Phase 0a: route to status_check class (one-shot human re-confirm) OR Phase 0b live re-scrape (TBD by Alex based on bucket size).`,
    data_examined: {
      live_status: listing.liveStatus,
      last_verified: listing.lastVerified,
      age_hours: isFinite(verifiedAge) ? verifiedAge : null,
      fresh_threshold_hours: FRESH_VERIFICATION_HOURS,
    },
    pending_writes: null,
  };
}

export interface ScrubSummary {
  total_examined: number;
  by_bucket: Record<ScrubBucket, number>;
  pending_writes_summary: {
    do_not_text_to_be_set: number;
    pipeline_stage_dead_to_be_set: number;
  };
  never_list_size: number;
  never_list_warning: string | null;
}

export function summarize(results: ScrubResult[]): ScrubSummary {
  const by_bucket: Record<ScrubBucket, number> = {
    active_eligible: 0,
    off_market_killed: 0,
    pending_reverification: 0,
    skip_restricted_state: 0,
    skip_never_list: 0,
    skip_pipeline_active: 0,
    skip_invalid_phone: 0,
  };
  let do_not_text = 0;
  let pipeline_dead = 0;
  for (const r of results) {
    by_bucket[r.bucket]++;
    if (r.pending_writes?.Do_Not_Text === true) do_not_text++;
    if (r.pending_writes?.Pipeline_Stage === "dead") pipeline_dead++;
  }
  return {
    total_examined: results.length,
    by_bucket,
    pending_writes_summary: {
      do_not_text_to_be_set: do_not_text,
      pipeline_stage_dead_to_be_set: pipeline_dead,
    },
    never_list_size: NEVER_LIST.length,
    never_list_warning: NEVER_LIST.length === 0
      ? "NEVER-list is empty (0 entries in lib/config/never_list.json). Alex 5/13 directive references '12 known from Bible v3' — populate before D3 follow-up cadence fires. PO-04 + skip_never_list bucket will never match until populated."
      : null,
  };
}
