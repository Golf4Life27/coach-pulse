// Maverick — state aggregator orchestration + cache.
// @agent: maverick (Day 2)
//
// One-pass parallel fetch of all 9 sources, builds the
// StructuredBriefing, calls the synthesizer with template fallback,
// applies stale-while-revalidate caching at the briefing level.
//
// Cache rules (Spec v1.1 §5 Step 1):
//   - Fresh: cached < 90s ago → return immediately, no revalidation
//   - Stale: cached 90s-5min ago → return cached, fire background refresh
//   - Cold: cached > 5min ago OR absent → full fetch synchronously
//
// All cross-source synthesis (RentCast burn-rate, deploy-behind-HEAD)
// happens here, not in any individual fetcher.

import { fetchGitState } from "./sources/git";
import { fetchAirtableListingsState } from "./sources/airtable-listings";
import { fetchAirtableSpineState } from "./sources/airtable-spine";
import { fetchVercelKvAuditState } from "./sources/vercel-kv-audit";
import { fetchCodebaseMetadataState } from "./sources/codebase-metadata";
import { fetchActionQueueState } from "./sources/action-queue";
import { fetchExternalRentCastState } from "./sources/external-rentcast";
import { fetchExternalQuoState } from "./sources/external-quo";
import { fetchExternalVercelState } from "./sources/external-vercel";
import type { SourceResult, SourceName } from "./types";
import {
  type Briefing,
  type StructuredBriefing,
  type SourceHealth,
  type BuildStateSection,
  type AuditSummarySection,
  type ExternalSignalsSection,
  EMPTY_GIT,
  EMPTY_LISTINGS,
  EMPTY_SPINE,
  EMPTY_AUDIT,
  EMPTY_CODEBASE,
  EMPTY_QUEUE,
  EMPTY_RENTCAST,
  EMPTY_QUO,
  EMPTY_VERCEL,
  dataOrFallback,
  healthOf,
} from "./briefing";
import { computeBurnRate } from "./rentcast-burn-rate";
import { renderTemplate } from "./template";
import { synthesizeNarrative } from "./synthesize";

// Cache configuration per Spec v1.1 §5 Step 1.
const CACHE_FRESH_MS = 90_000; // <90s → serve cache, no revalidation
const CACHE_STALE_MS = 5 * 60_000; // 90s-5min → serve stale, refresh in bg
// >5min → full synchronous rebuild

// Default since-window for the briefing.
const DEFAULT_SINCE_HOURS = 24;

// In-process cache. Persists only within a warm lambda instance.
// Cold-start lambdas rebuild from scratch — acceptable per spec.
interface CacheEntry {
  briefing: Briefing;
  cached_at: number;
}
let cache: CacheEntry | null = null;
let backgroundRevalidationInFlight = false;

export interface BuildBriefingOpts {
  // ISO string or Date for the "since" anchor. Defaults to 24h ago.
  since?: Date | string;
  // Bypass cache and force a fresh fetch. Used by manual diagnostic
  // hits (e.g., curl ?cache=skip) and on first call after deploy.
  skipCache?: boolean;
  // Per-source timeout overrides for tests. Each fetcher applies its
  // own default budget otherwise.
  fetcherTimeoutsMs?: Partial<Record<SourceName, number>>;
  // Synthesis timeout override for tests.
  synthesisTimeoutMs?: number;
}

/**
 * Top-level aggregator entry point. Applies cache, fetches if needed,
 * builds briefing, returns.
 */
export async function buildBriefing(opts: BuildBriefingOpts = {}): Promise<Briefing> {
  const now = Date.now();

  if (!opts.skipCache && cache) {
    const age = now - cache.cached_at;
    if (age < CACHE_FRESH_MS) {
      return markCached(cache.briefing);
    }
    if (age < CACHE_STALE_MS) {
      // Stale-while-revalidate: return cached now, refresh in bg.
      if (!backgroundRevalidationInFlight) {
        backgroundRevalidationInFlight = true;
        void (async () => {
          try {
            await rebuildAndStore(opts);
          } finally {
            backgroundRevalidationInFlight = false;
          }
        })();
      }
      return markCached(cache.briefing);
    }
  }

  return rebuildAndStore(opts);
}

async function rebuildAndStore(opts: BuildBriefingOpts): Promise<Briefing> {
  const briefing = await rebuildBriefing(opts);
  cache = { briefing, cached_at: Date.now() };
  return briefing;
}

function markCached(b: Briefing): Briefing {
  // Flip served_from_cache on every source_health entry so callers
  // see the briefing came from cache. The underlying briefing object
  // is mutated here — but we copy first so we don't mutate the
  // cached entry in place across calls.
  const cloned = {
    ...b,
    source_health: Object.fromEntries(
      Object.entries(b.source_health).map(([k, v]) => [k, { ...v, served_from_cache: true }]),
    ) as Record<SourceName, SourceHealth>,
  };
  return cloned;
}

/**
 * Pure rebuild: parallel fetch all sources, compose briefing, call
 * synthesizer. Exported so tests can hit it with injected fetchers.
 */
export async function rebuildBriefing(opts: BuildBriefingOpts): Promise<Briefing> {
  const t0 = Date.now();
  const sinceDate =
    opts.since instanceof Date
      ? opts.since
      : opts.since
        ? new Date(opts.since)
        : new Date(Date.now() - DEFAULT_SINCE_HOURS * 60 * 60_000);
  const fetcherTimeouts = opts.fetcherTimeoutsMs ?? {};

  // Parallel-fetch every source. Promise.allSettled guarantees one
  // bad fetcher can't crash the briefing.
  const settled = await Promise.allSettled([
    fetchGitState({ since: sinceDate, timeoutMs: fetcherTimeouts.git }),
    fetchAirtableListingsState({ since: sinceDate, timeoutMs: fetcherTimeouts.airtable_listings }),
    fetchAirtableSpineState({ since: sinceDate, timeoutMs: fetcherTimeouts.airtable_spine }),
    fetchVercelKvAuditState({ since: sinceDate, timeoutMs: fetcherTimeouts.vercel_kv_audit }),
    fetchCodebaseMetadataState({ since: sinceDate, timeoutMs: fetcherTimeouts.codebase_metadata }),
    fetchActionQueueState({ since: sinceDate, timeoutMs: fetcherTimeouts.action_queue }),
    fetchExternalRentCastState({ since: sinceDate, timeoutMs: fetcherTimeouts.external_rentcast }),
    fetchExternalQuoState({ since: sinceDate, timeoutMs: fetcherTimeouts.external_quo }),
    fetchExternalVercelState({ since: sinceDate, timeoutMs: fetcherTimeouts.external_vercel }),
  ]);

  // Promise.allSettled wraps each result in {status, value|reason}.
  // Each of our fetchers internally catches and returns a
  // SourceResult — they never throw — so settled.value is always
  // present. Treat any "rejected" as a defensive fallback.
  const results = settled.map(
    (s) => (s.status === "fulfilled" ? s.value : null) as SourceResult<unknown> | null,
  );
  const [gitR, listingsR, spineR, auditR, codebaseR, queueR, rentcastR, quoR, vercelR] = results;

  // Type-narrowed accessors. dataOrFallback's T is inferred from the
  // fallback argument; the typed value comes back even though the
  // input result is SourceResult<unknown>.
  const git = dataOrFallback(gitR, EMPTY_GIT);
  const listings = dataOrFallback(listingsR, EMPTY_LISTINGS);
  const spine = dataOrFallback(spineR, EMPTY_SPINE);
  const audit = dataOrFallback(auditR, EMPTY_AUDIT);
  const codebase = dataOrFallback(codebaseR, EMPTY_CODEBASE);
  const queue = dataOrFallback(queueR, EMPTY_QUEUE);
  const rentcast = dataOrFallback(rentcastR, EMPTY_RENTCAST);
  const quo = dataOrFallback(quoR, EMPTY_QUO);
  const vercel = dataOrFallback(vercelR, EMPTY_VERCEL);

  // source_health table from raw results (pre-cache markers).
  const source_health: Record<SourceName, SourceHealth> = {
    git: healthOf(asResult(gitR, "git")),
    airtable_listings: healthOf(asResult(listingsR, "airtable_listings")),
    airtable_spine: healthOf(asResult(spineR, "airtable_spine")),
    vercel_kv_audit: healthOf(asResult(auditR, "vercel_kv_audit")),
    codebase_metadata: healthOf(asResult(codebaseR, "codebase_metadata")),
    action_queue: healthOf(asResult(queueR, "action_queue")),
    external_rentcast: healthOf(asResult(rentcastR, "external_rentcast")),
    external_quo: healthOf(asResult(quoR, "external_quo")),
    external_vercel: healthOf(asResult(vercelR, "external_vercel")),
  };

  // Cross-source synthesis: RentCast burn rate joins audit data with
  // RentCast's monthly cap.
  const windowHours = Math.max(
    1,
    Math.round((Date.now() - sinceDate.getTime()) / (60 * 60_000)),
  );
  const cycleDaysElapsed = computeCycleDaysElapsed(new Date());
  const burnRate = computeBurnRate({
    rentcast: rentcast as typeof EMPTY_RENTCAST,
    audit: source_health.vercel_kv_audit.ok ? (audit as typeof EMPTY_AUDIT) : null,
    windowHours,
    daysElapsedInCycle: cycleDaysElapsed,
  });

  // Cross-source synthesis: deploy-behind-HEAD comparison.
  const behind_head = computeDeployBehindHead(git.latest_commit?.sha, vercel.latest_deploy_sha);

  // Compose the build_state section.
  const build_state: BuildStateSection = {
    branch: git.branch,
    branch_resolved: git.branch_resolved,
    latest_commit: git.latest_commit,
    commits_since_count: git.commits_since.length,
    commits_since: git.commits_since,
    files_changed_since: git.files_changed_since,
    tests: {
      count: codebase.test_count,
      source: codebase.test_count_source,
      ci_state: codebase.latest_ci_state,
      ci_sha: codebase.latest_ci_sha,
    },
    deploy: {
      id: vercel.latest_deploy_id,
      url: vercel.latest_deploy_url,
      state: vercel.latest_deploy_state,
      sha: vercel.latest_deploy_sha,
      short_sha: vercel.latest_deploy_short_sha,
      branch: vercel.latest_deploy_branch,
      ready_at: vercel.latest_deploy_ready_at,
      behind_head,
    },
    package_name: codebase.package_name,
    package_version: codebase.package_version,
  };

  const audit_summary: AuditSummarySection = {
    total_events_since: audit.total_events_since,
    by_agent: audit.recent_events_by_agent,
    recent_failures: audit.recent_failures,
  };

  const external_signals: ExternalSignalsSection = {
    rentcast: { ...rentcast, burn_rate: burnRate },
    quo,
    vercel,
  };

  // Staleness warnings: surface any source where ok=false OR
  // staleness exceeds a per-source threshold.
  const staleness_warnings = buildStalenessWarnings(source_health);

  const generated_at = new Date().toISOString();
  const structured: StructuredBriefing = {
    generated_at,
    duration_ms: 0, // filled in below after synthesis completes
    since: sinceDate.toISOString(),
    build_state,
    active_deals: listings.active_deals,
    pipeline_counts: listings.pipeline_counts,
    texted_universe_size: listings.texted_universe_size,
    open_decisions: queue.d3_manual_fix_queue_pending_sample,
    recent_key_decisions: spine.recent_decisions,
    audit_summary,
    external_signals,
    staleness_warnings,
  };

  // Render template fallback first — synthesis race uses it.
  const fallbackNarrative = renderTemplate(structured);

  const synth = await synthesizeNarrative({
    structured,
    timeoutMs: opts.synthesisTimeoutMs,
    fallbackNarrative,
  });

  const duration_ms = Date.now() - t0;
  structured.duration_ms = duration_ms;

  return {
    generated_at,
    duration_ms,
    narrative: synth.narrative,
    narrative_synthesized: synth.synthesized,
    narrative_error: synth.error,
    structured,
    source_health,
  };
}

/**
 * Pure helper — given the latest git commit SHA and the latest
 * Vercel deploy SHA, decide whether the deploy is behind HEAD.
 */
export function computeDeployBehindHead(
  headSha: string | null | undefined,
  deploySha: string | null | undefined,
): boolean | null {
  if (!headSha || !deploySha) return null;
  return headSha !== deploySha;
}

/**
 * Days elapsed in the current billing cycle (RentCast resets monthly
 * on the 1st UTC). Pure.
 */
export function computeCycleDaysElapsed(now: Date): number {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return Math.max(0, Math.floor((now.getTime() - startOfMonth.getTime()) / 86_400_000));
}

/**
 * Pure helper — derive the staleness_warnings list from
 * source_health. Surfaces any non-ok source plus any source whose
 * staleness exceeds 5 minutes.
 */
export function buildStalenessWarnings(
  source_health: Record<SourceName, SourceHealth>,
): string[] {
  const warnings: string[] = [];
  for (const [name, h] of Object.entries(source_health)) {
    if (!h.ok) {
      warnings.push(`${name}: ${h.error ?? "unreachable"}`);
    } else if (h.staleness_seconds > 300) {
      warnings.push(`${name}: data is ${Math.floor(h.staleness_seconds / 60)}min old`);
    }
  }
  return warnings;
}

// ---- private helpers ----

function asResult<T>(r: SourceResult<unknown> | null, source: SourceName): SourceResult<T> {
  if (r) return r as SourceResult<T>;
  return {
    source,
    ok: false,
    data: null as T | null,
    error: "fetcher rejected at allSettled level (should never happen)",
    latency_ms: 0,
    staleness_seconds: 0,
    served_from_cache: false,
  };
}

// Test-only escape hatch: lets tests reset the in-process cache
// between describes. Not exported in production usage.
export function __resetCacheForTests(): void {
  cache = null;
  backgroundRevalidationInFlight = false;
}
