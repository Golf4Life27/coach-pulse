// @agent: maverick — synthesizer request-builder tests.
//
// Network-level synthesis isn't testable in CI without an API key
// and live Anthropic latency. These tests target the pure
// buildRequestBody surface — system prompt content, cache markers,
// user-content shape — to guarantee the prompt structure stays
// stable across refactors.

import { describe, it, expect } from "vitest";
import { buildRequestBody } from "./synthesize";
import type { StructuredBriefing } from "./briefing";

function structured(over: Partial<StructuredBriefing> = {}): StructuredBriefing {
  return {
    generated_at: "2026-05-15T18:00:00Z",
    duration_ms: 0,
    since: "2026-05-14T18:00:00Z",
    build_state: {
      branch: "x",
      branch_resolved: true,
      latest_commit: null,
      commits_since_count: 0,
      commits_since: [],
      files_changed_since: [],
      tests: { count: null, source: "unknown", ci_state: "unknown", ci_sha: null },
      deploy: {
        id: null,
        url: null,
        state: "UNKNOWN",
        sha: null,
        short_sha: null,
        branch: null,
        ready_at: null,
        behind_head: null,
      },
      package_name: null,
      package_version: null,
    },
    active_deals: [],
    pipeline_counts: {},
    texted_universe_size: 0,
    open_decisions: [],
    recent_key_decisions: [],
    audit_summary: {
      total_events_since: 0,
      by_agent: {},
      recent_failures: [],
      mcp_call_latency: { samples: 0, p50_ms: null, p95_ms: null, p99_ms: null, by_tool: {}, over_target_count: 0, p95_target_ms: 30_000 },
    },
    external_signals: {
      rentcast: {
        api_responsive: false,
        api_key_configured: false,
        monthly_cap: 0,
        reset_date_utc: "",
        days_until_reset: 0,
        probe_latency_ms: 0,
        burn_rate: {
          pricing_calls_in_window: 0,
          estimated_calls_in_window: 0,
          window_hours: 24,
          burn_rate_per_day: 0,
          days_until_exhaustion_estimate: null,
          estimated_calls_remaining: 0,
        },
      },
      quo: {
        api_responsive: false,
        api_key_configured: false,
        most_recent_outbound_at: null,
        most_recent_inbound_at: null,
        messages_last_24h: 0,
      },
      vercel: {
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
      },
    },
    staleness_warnings: [],
    ...over,
  };
}

describe("buildRequestBody", () => {
  it("uses claude-sonnet-4-6 as the synthesis model", () => {
    const body = buildRequestBody(structured()) as { model: string };
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  it("marks the system prompt with cache_control: ephemeral for prompt caching", () => {
    const body = buildRequestBody(structured()) as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    };
    expect(body.system).toHaveLength(1);
    expect(body.system[0].type).toBe("text");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("system prompt includes the named-agent roster verbatim", () => {
    const body = buildRequestBody(structured()) as {
      system: Array<{ text: string }>;
    };
    const sys = body.system[0].text;
    for (const name of ["Sentinel", "Appraiser", "Forge", "Crier", "Sentry", "Scribe", "Scout", "Pulse", "Ledger", "Maverick"]) {
      expect(sys).toContain(name);
    }
  });

  it("system prompt includes the non-hallucination guardrail", () => {
    const body = buildRequestBody(structured()) as { system: Array<{ text: string }> };
    const sys = body.system[0].text;
    expect(sys).toMatch(/NEVER invent or substitute deterministic facts/);
  });

  it("user content embeds the structured payload as JSON", () => {
    const body = buildRequestBody(
      structured({ texted_universe_size: 25 }),
    ) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain('"texted_universe_size": 25');
  });

  it("max_tokens is bounded to keep latency predictable", () => {
    const body = buildRequestBody(structured()) as { max_tokens: number };
    expect(body.max_tokens).toBeLessThanOrEqual(2048);
    expect(body.max_tokens).toBeGreaterThanOrEqual(512);
  });
});
