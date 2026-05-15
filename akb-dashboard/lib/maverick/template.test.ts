// @agent: maverick — template renderer tests.
//
// The template must NEVER hallucinate facts. Tests verify that
// every deterministic value from the StructuredBriefing appears
// verbatim in the rendered output.

import { describe, it, expect } from "vitest";
import { renderTemplate } from "./template";
import type { StructuredBriefing } from "./briefing";

function minimalBriefing(over: Partial<StructuredBriefing> = {}): StructuredBriefing {
  return {
    generated_at: "2026-05-15T18:00:00Z",
    duration_ms: 12340,
    since: "2026-05-14T18:00:00Z",
    build_state: {
      branch: "claude/maverick-aggregator",
      branch_resolved: true,
      latest_commit: {
        sha: "a0ea0211b7c234a16b7dca0fb2b35c2ed95a5393",
        short_sha: "a0ea021",
        message: "feat(d3): widen Layer 1 depth-gate",
        author: "Claude",
        date: "2026-05-15T02:37:00Z",
      },
      commits_since_count: 3,
      commits_since: [],
      files_changed_since: [],
      tests: {
        count: 101,
        source: "prebuild_artifact",
        ci_state: "passing",
        ci_sha: "abc",
      },
      deploy: {
        id: "dpl_test123",
        url: "coach-pulse-test.vercel.app",
        state: "READY",
        sha: "a0ea0211b7c234a16b7dca0fb2b35c2ed95a5393",
        short_sha: "a0ea021",
        branch: "claude/maverick-aggregator",
        ready_at: "2026-05-15T02:38:00Z",
        behind_head: false,
      },
      package_name: "akb-dashboard",
      package_version: "0.1.0",
    },
    active_deals: [],
    pipeline_counts: {},
    texted_universe_size: 0,
    open_decisions: [],
    recent_key_decisions: [],
    audit_summary: { total_events_since: 0, by_agent: {}, recent_failures: [] },
    external_signals: {
      rentcast: {
        api_responsive: true,
        api_key_configured: true,
        monthly_cap: 1000,
        reset_date_utc: "2026-06-01",
        days_until_reset: 17,
        probe_latency_ms: 100,
        burn_rate: {
          pricing_calls_in_window: 5,
          estimated_calls_in_window: 10,
          window_hours: 24,
          burn_rate_per_day: 10,
          days_until_exhaustion_estimate: 90,
          estimated_calls_remaining: 900,
        },
      },
      quo: {
        api_responsive: true,
        api_key_configured: true,
        most_recent_outbound_at: "2026-05-15T01:00:00Z",
        most_recent_inbound_at: "2026-05-15T03:00:00Z",
        messages_last_24h: 7,
      },
      vercel: {
        api_token_configured: true,
        latest_deploy_id: "dpl_test123",
        latest_deploy_url: "coach-pulse-test.vercel.app",
        latest_deploy_state: "READY",
        latest_deploy_sha: "a0ea0211b7c234a16b7dca0fb2b35c2ed95a5393",
        latest_deploy_short_sha: "a0ea021",
        latest_deploy_branch: "claude/maverick-aggregator",
        latest_deploy_ready_at: "2026-05-15T02:38:00Z",
        latest_deploy_created_at: "2026-05-15T02:37:00Z",
        active_branch_observed: "claude/maverick-aggregator",
      },
    },
    staleness_warnings: [],
    ...over,
  };
}

describe("renderTemplate — deterministic-fact preservation", () => {
  it("includes the branch name verbatim", () => {
    const out = renderTemplate(minimalBriefing());
    expect(out).toContain("claude/maverick-aggregator");
  });

  it("includes the latest commit short SHA + message verbatim", () => {
    const out = renderTemplate(minimalBriefing());
    expect(out).toContain("a0ea021");
    expect(out).toContain("feat(d3): widen Layer 1 depth-gate");
  });

  it("includes test count verbatim when available", () => {
    const out = renderTemplate(minimalBriefing());
    expect(out).toContain("101 in suite");
  });

  it("reports '(count unavailable)' when test_count is null", () => {
    const out = renderTemplate(
      minimalBriefing({
        build_state: {
          ...minimalBriefing().build_state,
          tests: { count: null, source: "unknown", ci_state: "unknown", ci_sha: null },
        },
      }),
    );
    expect(out).toContain("(count unavailable)");
  });

  it("surfaces deploy state + short SHA in the build section", () => {
    const out = renderTemplate(minimalBriefing());
    expect(out).toContain("READY");
    expect(out).toMatch(/Production deploy: READY \(a0ea021\)/);
  });

  it("flags BEHIND HEAD when deploy.behind_head is true", () => {
    const out = renderTemplate(
      minimalBriefing({
        build_state: {
          ...minimalBriefing().build_state,
          deploy: { ...minimalBriefing().build_state.deploy, behind_head: true },
        },
      }),
    );
    expect(out).toContain("BEHIND HEAD");
  });

  it("does not include BEHIND HEAD when deploy is in sync", () => {
    const out = renderTemplate(minimalBriefing());
    expect(out).not.toContain("BEHIND HEAD");
  });
});

describe("renderTemplate — active deals section", () => {
  it("renders no-active-deals state cleanly", () => {
    const out = renderTemplate(minimalBriefing());
    expect(out).toContain("ACTIVE DEALS (0)");
    expect(out).toContain("(no active negotiations)");
  });

  it("lists active deals with address + status + stored_offer + recency", () => {
    const out = renderTemplate(
      minimalBriefing({
        active_deals: [
          {
            id: "rec1",
            address: "23 Fields Ave",
            city: "Memphis",
            status: "Negotiating",
            list_price: 95000,
            stored_offer_price: 61750,
            last_outreach_date: "2026-05-13",
            last_inbound_at: "2026-05-14T11:31:00Z",
            last_outbound_at: "2026-05-14T11:31:00Z",
            agent_name: "Candice Hardaway",
            days_since_send: 1,
            days_since_inbound: 1,
          },
        ],
      }),
    );
    expect(out).toContain("23 Fields Ave");
    expect(out).toContain("Memphis");
    expect(out).toContain("Negotiating");
    expect(out).toContain("$61,750");
    expect(out).toContain("last inbound 1d ago");
  });

  it("truncates active_deals at 10 with a 'N more' tail", () => {
    const dummy = {
      id: "x",
      address: "X",
      city: "X",
      status: "Negotiating",
      list_price: 0,
      stored_offer_price: 0,
      last_outreach_date: null,
      last_inbound_at: null,
      last_outbound_at: null,
      agent_name: null,
      days_since_send: null,
      days_since_inbound: null,
    } as const;
    const out = renderTemplate(
      minimalBriefing({
        active_deals: Array.from({ length: 15 }, (_, i) => ({ ...dummy, id: `r${i}` })),
      }),
    );
    expect(out).toContain("ACTIVE DEALS (15)");
    expect(out).toContain("... 5 more");
  });
});

describe("renderTemplate — RentCast burn-rate surface", () => {
  it("includes monthly cap, remaining estimate, burn rate, and days-until-exhaustion", () => {
    const out = renderTemplate(minimalBriefing());
    expect(out).toContain("cap 1000");
    expect(out).toContain("900 remaining");
    expect(out).toContain("10/day");
    expect(out).toContain("~90d until exhaustion");
  });

  it("omits days-until-exhaustion when burn rate is 0", () => {
    const out = renderTemplate(
      minimalBriefing({
        external_signals: {
          ...minimalBriefing().external_signals,
          rentcast: {
            ...minimalBriefing().external_signals.rentcast,
            burn_rate: {
              pricing_calls_in_window: 0,
              estimated_calls_in_window: 0,
              window_hours: 24,
              burn_rate_per_day: 0,
              days_until_exhaustion_estimate: null,
              estimated_calls_remaining: 1000,
            },
          },
        },
      }),
    );
    expect(out).toContain("burn 0/day");
    expect(out).not.toContain("until exhaustion");
  });
});

describe("renderTemplate — staleness warnings", () => {
  it("renders staleness warnings section when present", () => {
    const out = renderTemplate(
      minimalBriefing({
        staleness_warnings: ["external_quo: timeout", "external_vercel: 401 unauthorized"],
      }),
    );
    expect(out).toContain("STALENESS WARNINGS");
    expect(out).toContain("external_quo: timeout");
    expect(out).toContain("external_vercel: 401 unauthorized");
  });

  it("omits warnings section when none present", () => {
    const out = renderTemplate(minimalBriefing());
    expect(out).not.toContain("STALENESS WARNINGS");
  });
});

describe("renderTemplate — ending verbiage", () => {
  it("always ends with the canonical session-open question", () => {
    const out = renderTemplate(minimalBriefing());
    expect(out.trim().endsWith("What do you want to work on?")).toBe(true);
  });
});
