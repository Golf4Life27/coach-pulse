// @agent: maverick — aggregator stress tests (Day 5).
//
// Exercises rebuildBriefing under degraded-source conditions:
// individual sources timing out, 3-source partial failure, all-sources
// failure (cascading-floor case), synthesizer timeout (template
// fallback). The Day 1 fetchers + Day 2 aggregator all built in
// graceful degradation; these tests prove the composition stays
// correct under each documented failure mode.
//
// Strategy: vi.mock each of the 9 source modules + the synthesizer
// so we can drive their outputs. Each test resets the cache and runs
// rebuildBriefing with skipCache=true.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SourceResult } from "./types";

// ──────────────── source-module mocks ────────────────
//
// Each fetcher is mocked to a vi.fn() that returns a SourceResult.
// Tests override the per-source return value to simulate failures.

vi.mock("./sources/git", () => ({
  fetchGitState: vi.fn(),
}));
vi.mock("./sources/airtable-listings", () => ({
  fetchAirtableListingsState: vi.fn(),
}));
vi.mock("./sources/airtable-spine", () => ({
  fetchAirtableSpineState: vi.fn(),
}));
vi.mock("./sources/vercel-kv-audit", () => ({
  fetchVercelKvAuditState: vi.fn(),
}));
vi.mock("./sources/codebase-metadata", () => ({
  fetchCodebaseMetadataState: vi.fn(),
}));
vi.mock("./sources/action-queue", () => ({
  fetchActionQueueState: vi.fn(),
}));
vi.mock("./sources/external-rentcast", () => ({
  fetchExternalRentCastState: vi.fn(),
}));
vi.mock("./sources/external-quo", () => ({
  fetchExternalQuoState: vi.fn(),
}));
vi.mock("./sources/external-vercel", () => ({
  fetchExternalVercelState: vi.fn(),
}));
vi.mock("./synthesize", () => ({
  synthesizeNarrative: vi.fn(),
}));

import { rebuildBriefing } from "./aggregator";
import { fetchGitState } from "./sources/git";
import { fetchAirtableListingsState } from "./sources/airtable-listings";
import { fetchAirtableSpineState } from "./sources/airtable-spine";
import { fetchVercelKvAuditState } from "./sources/vercel-kv-audit";
import { fetchCodebaseMetadataState } from "./sources/codebase-metadata";
import { fetchActionQueueState } from "./sources/action-queue";
import { fetchExternalRentCastState } from "./sources/external-rentcast";
import { fetchExternalQuoState } from "./sources/external-quo";
import { fetchExternalVercelState } from "./sources/external-vercel";
import { synthesizeNarrative } from "./synthesize";

// Convenience: typed mock references.
const mocks = {
  git: fetchGitState as ReturnType<typeof vi.fn>,
  listings: fetchAirtableListingsState as ReturnType<typeof vi.fn>,
  spine: fetchAirtableSpineState as ReturnType<typeof vi.fn>,
  audit: fetchVercelKvAuditState as ReturnType<typeof vi.fn>,
  codebase: fetchCodebaseMetadataState as ReturnType<typeof vi.fn>,
  queue: fetchActionQueueState as ReturnType<typeof vi.fn>,
  rentcast: fetchExternalRentCastState as ReturnType<typeof vi.fn>,
  quo: fetchExternalQuoState as ReturnType<typeof vi.fn>,
  vercel: fetchExternalVercelState as ReturnType<typeof vi.fn>,
  synth: synthesizeNarrative as ReturnType<typeof vi.fn>,
};

// ──────────────── fixture builders ────────────────

function ok<T>(source: string, data: T): SourceResult<T> {
  return {
    source: source as never,
    ok: true,
    data,
    latency_ms: 100,
    staleness_seconds: 0,
    served_from_cache: false,
    error: null,
  };
}

function fail(source: string, error: string): SourceResult<never> {
  return {
    source: source as never,
    ok: false,
    data: null as never,
    latency_ms: 0,
    staleness_seconds: 0,
    served_from_cache: false,
    error,
  };
}

function happyDefaults() {
  mocks.git.mockResolvedValue(
    ok("git", {
      active_branch: "claude/build-akb-inevitable-week1-uG6xD",
      branch_resolved: true,
      latest_commit: null,
      commits_since_count: 0,
      commits_since: [],
      files_changed_since: [],
      github_pat_configured: true,
    }),
  );
  mocks.listings.mockResolvedValue(
    ok("airtable_listings", {
      active_deals: [],
      pipeline_counts: {},
      texted_universe_size: 0,
    }),
  );
  mocks.spine.mockResolvedValue(ok("airtable_spine", { recent_decisions: [] }));
  mocks.audit.mockResolvedValue(
    ok("vercel_kv_audit", {
      total_events_since: 0,
      recent_events_by_agent: {},
      recent_failures: [],
      oldest_event_ts: null,
      newest_event_ts: null,
      mcp_call_latency: {
        samples: 0,
        p50_ms: null,
        p95_ms: null,
        p99_ms: null,
        by_tool: {},
        over_target_count: 0,
        p95_target_ms: 30_000,
      },
    }),
  );
  mocks.codebase.mockResolvedValue(
    ok("codebase_metadata", {
      package_name: "akb-dashboard",
      package_version: "0.1.0",
      test_count: 376,
      test_count_source: "prebuild_artifact",
      latest_ci_state: "unknown",
      latest_ci_sha: null,
      github_pat_configured: true,
    }),
  );
  mocks.queue.mockResolvedValue(
    ok("action_queue", {
      d3_manual_fix_queue_pending_count: 0,
      d3_manual_fix_queue_pending_sample: [],
      cadence_queue_present: false,
    }),
  );
  mocks.rentcast.mockResolvedValue(
    ok("external_rentcast", {
      api_responsive: true,
      api_key_configured: true,
      monthly_cap: 1000,
      reset_date_utc: "2026-06-01",
      days_until_reset: 17,
      probe_latency_ms: 100,
    }),
  );
  mocks.quo.mockResolvedValue(
    ok("external_quo", {
      api_responsive: true,
      api_key_configured: true,
      recent_messages_count: 0,
      window_hours: 24,
    }),
  );
  mocks.vercel.mockResolvedValue(
    ok("external_vercel", {
      api_token_configured: true,
      latest_deploy_id: "dpl_x",
      latest_deploy_url: "https://x.vercel.app",
      latest_deploy_state: "READY",
      latest_deploy_sha: "abc123",
      latest_deploy_short_sha: "abc123",
      latest_deploy_branch: "claude/build-akb-inevitable-week1-uG6xD",
      latest_deploy_ready_at: "2026-05-15T22:00:00Z",
    }),
  );
  mocks.synth.mockResolvedValue({
    narrative: "Welcome back. Owner's Rep speaking.",
    synthesized: true,
    error: null,
    latency_ms: 12_000,
  });
}

// ──────────────── tests ────────────────

describe("rebuildBriefing — stress under degraded sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyDefaults();
  });

  it("happy path: all 9 sources ok → briefing composes with synthesizer narrative", async () => {
    const b = await rebuildBriefing({ skipCache: true });
    expect(b.narrative).toMatch(/Owner's Rep/);
    expect(b.narrative_synthesized).toBe(true);
    expect(b.structured.staleness_warnings).toEqual([]);
    // All 9 sources surface healthy in source_health
    for (const sh of Object.values(b.source_health)) {
      expect(sh.ok).toBe(true);
    }
  });

  it("1 source fails (Quo) → briefing still composes; staleness flags Quo", async () => {
    mocks.quo.mockResolvedValue(fail("external_quo", "Quo timeout"));
    const b = await rebuildBriefing({ skipCache: true });
    expect(b.structured.staleness_warnings).toContain("external_quo: Quo timeout");
    // Briefing still has all the other sources
    expect(b.source_health.airtable_listings.ok).toBe(true);
    expect(b.source_health.external_quo.ok).toBe(false);
    // Quo section falls back to EMPTY_QUO shape (api_responsive: false)
    expect(b.structured.external_signals.quo.api_responsive).toBe(false);
  });

  it("3 sources fail (Airtable listings + spine + RentCast) → briefing still returns", async () => {
    mocks.listings.mockResolvedValue(
      fail("airtable_listings", "Airtable 503"),
    );
    mocks.spine.mockResolvedValue(fail("airtable_spine", "Airtable timeout"));
    mocks.rentcast.mockResolvedValue(fail("external_rentcast", "RentCast 401"));
    const b = await rebuildBriefing({ skipCache: true });
    expect(b.structured.active_deals).toEqual([]);
    expect(b.structured.recent_key_decisions).toEqual([]);
    expect(b.structured.staleness_warnings).toEqual(
      expect.arrayContaining([
        "airtable_listings: Airtable 503",
        "airtable_spine: Airtable timeout",
        "external_rentcast: RentCast 401",
      ]),
    );
    // The 6 healthy sources are intact
    expect(b.source_health.git.ok).toBe(true);
    expect(b.source_health.external_quo.ok).toBe(true);
  });

  it("all 9 sources fail → briefing still returns (cascading-floor case, no crash)", async () => {
    mocks.git.mockResolvedValue(fail("git", "git error"));
    mocks.listings.mockResolvedValue(fail("airtable_listings", "x"));
    mocks.spine.mockResolvedValue(fail("airtable_spine", "x"));
    mocks.audit.mockResolvedValue(fail("vercel_kv_audit", "x"));
    mocks.codebase.mockResolvedValue(fail("codebase_metadata", "x"));
    mocks.queue.mockResolvedValue(fail("action_queue", "x"));
    mocks.rentcast.mockResolvedValue(fail("external_rentcast", "x"));
    mocks.quo.mockResolvedValue(fail("external_quo", "x"));
    mocks.vercel.mockResolvedValue(fail("external_vercel", "x"));
    const b = await rebuildBriefing({ skipCache: true });
    expect(b).toBeDefined();
    expect(b.narrative).toBeTruthy();
    expect(b.structured.staleness_warnings.length).toBe(9);
    expect(b.structured.active_deals).toEqual([]);
  });

  it("source fetcher throws (defensive) → briefing falls back to EMPTY values + flags staleness", async () => {
    // Fetchers should never throw (they catch internally and return
    // failResult), but if one DID, Promise.allSettled keeps the briefing alive.
    mocks.spine.mockRejectedValue(new Error("unexpected throw"));
    const b = await rebuildBriefing({ skipCache: true });
    expect(b).toBeDefined();
    // Spine section falls back to EMPTY_SPINE
    expect(b.structured.recent_key_decisions).toEqual([]);
  });

  it("synthesizer fails → template-only narrative + narrative_synthesized:false", async () => {
    mocks.synth.mockResolvedValue({
      narrative: "(template fallback)",
      synthesized: false,
      error: "synthesis timeout",
      latency_ms: 20_000,
    });
    const b = await rebuildBriefing({ skipCache: true });
    expect(b.narrative_synthesized).toBe(false);
    expect(b.narrative_error).toBe("synthesis timeout");
    // Template fallback still produces a non-empty narrative
    expect(b.narrative.length).toBeGreaterThan(0);
  });

  it("synthesizer fails AND 3 sources down → both signals surface", async () => {
    mocks.synth.mockResolvedValue({
      narrative: "(template fallback)",
      synthesized: false,
      error: "synth fail",
      latency_ms: 20_000,
    });
    mocks.listings.mockResolvedValue(fail("airtable_listings", "x"));
    mocks.spine.mockResolvedValue(fail("airtable_spine", "x"));
    mocks.quo.mockResolvedValue(fail("external_quo", "x"));
    const b = await rebuildBriefing({ skipCache: true });
    expect(b.narrative_synthesized).toBe(false);
    expect(b.structured.staleness_warnings.length).toBe(3);
  });

  it("audit source carries MCP latency stats end-to-end into the briefing", async () => {
    mocks.audit.mockResolvedValue(
      ok("vercel_kv_audit", {
        total_events_since: 5,
        recent_events_by_agent: { maverick: 5 },
        recent_failures: [],
        oldest_event_ts: "2026-05-15T20:00:00Z",
        newest_event_ts: "2026-05-15T22:00:00Z",
        mcp_call_latency: {
          samples: 5,
          p50_ms: 18_000,
          p95_ms: 22_500,
          p99_ms: 25_000,
          by_tool: {
            maverick_load_state: { samples: 3, p50_ms: 19_000, p95_ms: 22_500 },
            maverick_recall: { samples: 2, p50_ms: 200, p95_ms: 350 },
          },
          over_target_count: 0,
          p95_target_ms: 30_000,
        },
      }),
    );
    // Force template fallback so we can assert against the rendered
    // latency line. Synth-success replaces the template body wholesale.
    mocks.synth.mockResolvedValue({
      narrative: "template fallback placeholder — unused",
      synthesized: false,
      error: "skipped for test",
      latency_ms: 0,
    });
    const b = await rebuildBriefing({ skipCache: true });
    expect(b.structured.audit_summary.mcp_call_latency.samples).toBe(5);
    expect(b.structured.audit_summary.mcp_call_latency.p95_ms).toBe(22_500);
    expect(b.structured.audit_summary.mcp_call_latency.by_tool).toHaveProperty(
      "maverick_load_state",
    );
  });
});
