// Maverick — Inevitable Continuity Layer
// @agent: maverick
//
// Shared types for the persistent state aggregator. Day 1 of the
// 5-day build path (Spec v1.1 §5 Step 1).
//
// Every source fetcher under lib/maverick/sources/ returns a
// SourceResult<T> with consistent error + latency + staleness
// metadata. The aggregator endpoint composes these results into the
// structured briefing + Claude-synthesized narrative.
//
// Audit attribution: all Maverick code, from line one, writes under
// agent: MAVERICK_AGENT. Existing per-domain agents (Sentry, Crier,
// Appraiser, etc.) keep their own attribution; Maverick is the
// orchestrator above them.

export const MAVERICK_AGENT = "maverick" as const;

export type SourceName =
  | "git"
  | "airtable_listings"
  | "airtable_spine"
  | "vercel_kv_audit"
  | "codebase_metadata"
  | "action_queue"
  | "external_rentcast"
  | "external_quo"
  | "external_vercel";

// Uniform result envelope. Aggregator builds source_health from these.
// staleness_seconds: how old the underlying data is (when known —
// some sources don't expose a "fetched at" timestamp; in that case
// staleness is measured from the call itself, treated as 0).
// served_from_cache: aggregator-level cache flips this to true on
// stale-while-revalidate hits; individual fetchers always emit false.
export interface SourceResult<T> {
  source: SourceName;
  ok: boolean;
  data: T | null;
  error: string | null;
  latency_ms: number;
  staleness_seconds: number;
  served_from_cache: boolean;
}

// Common per-fetch options. Each fetcher applies its own default
// timeout; opts.timeoutMs overrides for tests + caller-driven budgets.
export interface FetchOpts {
  // "Since" anchor — used by fetchers that surface deltas (git
  // commits since N, spine entries since N, audit events since N).
  // Defaults to 24h ago per Spec v1.1 §5 Step 1.
  since?: Date;
  // Per-call timeout. Falls back to the fetcher's default.
  timeoutMs?: number;
}

export function failResult<T>(
  source: SourceName,
  error: string,
  latency_ms: number,
): SourceResult<T> {
  return {
    source,
    ok: false,
    data: null,
    error,
    latency_ms,
    staleness_seconds: 0,
    served_from_cache: false,
  };
}

export function succeed<T>(
  source: SourceName,
  data: T,
  latency_ms: number,
  staleness_seconds = 0,
): SourceResult<T> {
  return {
    source,
    ok: true,
    data,
    error: null,
    latency_ms,
    staleness_seconds,
    served_from_cache: false,
  };
}
