// Maverick — structured briefing type definitions.
// @agent: maverick (Day 2)
//
// The aggregator composes a StructuredBriefing from the 9 source
// results. The template renderer + Claude synthesizer both consume
// this shape. Defining the type in its own file so both consumers
// import from one canonical surface.

import type { SourceName, SourceResult } from "./types";
import type { GitState, GitCommit } from "./sources/git";
import type { AirtableListingsState, ListingsActiveDeal } from "./sources/airtable-listings";
import type { AirtableSpineState, SpineEntry } from "./sources/airtable-spine";
import type { VercelKvAuditState } from "./sources/vercel-kv-audit";
import type { CodebaseMetadataState } from "./sources/codebase-metadata";
import type { ActionQueueState, ManualFixQueueItem } from "./sources/action-queue";
import type { RentCastState } from "./sources/external-rentcast";
import type { QuoState } from "./sources/external-quo";
import type { VercelDeployState } from "./sources/external-vercel";
import type { RentCastBurnRate } from "./rentcast-burn-rate";

export interface SourceHealth {
  source: SourceName;
  ok: boolean;
  latency_ms: number;
  staleness_seconds: number;
  served_from_cache: boolean;
  error: string | null;
}

export interface BuildStateSection {
  branch: string;
  branch_resolved: boolean;
  latest_commit: GitCommit | null;
  commits_since_count: number;
  commits_since: GitCommit[];
  files_changed_since: string[];
  tests: {
    count: number | null;
    source: CodebaseMetadataState["test_count_source"];
    ci_state: CodebaseMetadataState["latest_ci_state"];
    ci_sha: string | null;
  };
  deploy: {
    id: string | null;
    url: string | null;
    state: VercelDeployState["latest_deploy_state"];
    sha: string | null;
    short_sha: string | null;
    branch: string | null;
    ready_at: string | null;
    behind_head: boolean | null;
  };
  package_name: string | null;
  package_version: string | null;
}

export interface AuditSummarySection {
  total_events_since: number;
  by_agent: Record<string, number>;
  recent_failures: VercelKvAuditState["recent_failures"];
}

export interface ExternalSignalsSection {
  rentcast: RentCastState & {
    burn_rate: RentCastBurnRate;
  };
  quo: QuoState;
  vercel: VercelDeployState;
}

export interface StructuredBriefing {
  generated_at: string;
  duration_ms: number;
  since: string; // ISO of the "since" anchor the briefing was computed against
  build_state: BuildStateSection;
  active_deals: ListingsActiveDeal[];
  pipeline_counts: Record<string, number>;
  texted_universe_size: number;
  open_decisions: ManualFixQueueItem[];
  recent_key_decisions: SpineEntry[];
  audit_summary: AuditSummarySection;
  external_signals: ExternalSignalsSection;
  staleness_warnings: string[];
}

export interface Briefing {
  generated_at: string;
  duration_ms: number;
  narrative: string;
  // Was the narrative produced by the Claude synthesizer (true) or
  // by the template-only fallback (false)? Surfaced in the response
  // so callers can know whether the synthesis budget was met.
  narrative_synthesized: boolean;
  narrative_error: string | null;
  structured: StructuredBriefing;
  source_health: Record<SourceName, SourceHealth>;
}

// Helper used by the aggregator to build a SourceHealth from a
// SourceResult without leaking the (potentially large) data payload.
export function healthOf<T>(result: SourceResult<T>): SourceHealth {
  return {
    source: result.source,
    ok: result.ok,
    latency_ms: result.latency_ms,
    staleness_seconds: result.staleness_seconds,
    served_from_cache: result.served_from_cache,
    error: result.error,
  };
}

// Helper: pull data from a SourceResult, with a typed fallback if
// the fetch failed. Centralizes the "ok ? data : fallback" pattern.
// Takes SourceResult<unknown> so call sites can pass a heterogenous
// array's elements without per-call type assertions; T is inferred
// from the fallback argument.
export function dataOrFallback<T>(
  result: SourceResult<unknown> | null,
  fallback: T,
): T {
  if (result && result.ok && result.data) return result.data as T;
  return fallback;
}

// Empty/fallback values for each source — used when a fetcher fails
// so the briefing still renders a coherent shape.
export const EMPTY_GIT: GitState = {
  branch: "(unknown)",
  branch_resolved: false,
  latest_commit: null,
  commits_since: [],
  files_changed_since: [],
  github_pat_configured: false,
};

export const EMPTY_LISTINGS: AirtableListingsState = {
  pipeline_counts: {},
  active_deals: [],
  texted_universe_size: 0,
  total_listings: 0,
};

export const EMPTY_SPINE: AirtableSpineState = {
  total_since: 0,
  recent_decisions: [],
};

export const EMPTY_AUDIT: VercelKvAuditState = {
  total_events_since: 0,
  recent_events_by_agent: {},
  recent_failures: [],
  oldest_event_ts: null,
  newest_event_ts: null,
};

export const EMPTY_CODEBASE: CodebaseMetadataState = {
  package_name: null,
  package_version: null,
  test_count: null,
  test_count_source: "unknown",
  latest_ci_state: "unknown",
  latest_ci_sha: null,
  github_pat_configured: false,
};

export const EMPTY_QUEUE: ActionQueueState = {
  d3_manual_fix_queue_pending_count: 0,
  d3_manual_fix_queue_pending_sample: [],
  cadence_queue_pending_count: 0,
  cadence_queue_pending_sample: [],
};

export const EMPTY_RENTCAST: RentCastState = {
  api_responsive: false,
  api_key_configured: false,
  monthly_cap: 0,
  reset_date_utc: "",
  days_until_reset: 0,
  probe_latency_ms: 0,
};

export const EMPTY_QUO: QuoState = {
  api_responsive: false,
  api_key_configured: false,
  most_recent_outbound_at: null,
  most_recent_inbound_at: null,
  messages_last_24h: 0,
};

export const EMPTY_VERCEL: VercelDeployState = {
  api_token_configured: false,
  latest_deploy_id: null,
  latest_deploy_url: null,
  latest_deploy_state: "UNKNOWN",
  latest_deploy_sha: null,
  latest_deploy_short_sha: null,
  latest_deploy_branch: null,
  latest_deploy_ready_at: null,
  latest_deploy_created_at: null,
  active_branch_observed: "",
};
