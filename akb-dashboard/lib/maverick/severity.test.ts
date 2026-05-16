// @agent: maverick — severity tier inference tests.

import { describe, it, expect } from "vitest";
import {
  TIER_VISUAL,
  inferPrioritySignals,
  maxTier,
  type SeverityTier,
} from "./severity";

type Brief = Parameters<typeof inferPrioritySignals>[0];

function brief(over: Partial<Brief["structured"]> = {}, healthOver = {}): Brief {
  return {
    source_health: {
      git: { ok: true, error: null, staleness_seconds: 0 },
      airtable_listings: { ok: true, error: null, staleness_seconds: 0 },
      airtable_spine: { ok: true, error: null, staleness_seconds: 0 },
      vercel_kv_audit: { ok: true, error: null, staleness_seconds: 0 },
      codebase_metadata: { ok: true, error: null, staleness_seconds: 0 },
      action_queue: { ok: true, error: null, staleness_seconds: 0 },
      external_rentcast: { ok: true, error: null, staleness_seconds: 0 },
      external_quo: { ok: true, error: null, staleness_seconds: 0 },
      external_vercel: { ok: true, error: null, staleness_seconds: 0 },
      ...healthOver,
    },
    structured: {
      staleness_warnings: [],
      active_deals: [],
      open_decisions: [],
      recent_key_decisions: [],
      audit_summary: {
        recent_failures: [],
        mcp_call_latency: {
          samples: 0,
          p95_ms: null,
          over_target_count: 0,
          p95_target_ms: 30_000,
        },
      },
      external_signals: {
        quo: { api_responsive: true, api_key_configured: true },
        rentcast: {
          api_responsive: true,
          burn_rate: { days_until_exhaustion_estimate: null },
        },
      },
      ...over,
    },
  };
}

describe("inferPrioritySignals — happy state", () => {
  it("returns zero signals when everything is healthy + idle", () => {
    expect(inferPrioritySignals(brief())).toEqual([]);
  });
});

describe("inferPrioritySignals — infrastructure", () => {
  it("1 source down → single tier-2 signal", () => {
    const b = brief({}, {
      external_quo: { ok: false, error: "timeout", staleness_seconds: 0 },
    });
    const signals = inferPrioritySignals(b);
    const downSignal = signals.find((s) => s.id === "sources_down");
    expect(downSignal?.tier).toBe(2);
    expect(downSignal?.agent).toBe("maverick");
  });

  it(">5 sources down → tier-3 cascading-floor signal", () => {
    const downHealth = {
      git: { ok: false, error: "timeout", staleness_seconds: 0 },
      airtable_listings: { ok: false, error: "503", staleness_seconds: 0 },
      airtable_spine: { ok: false, error: "503", staleness_seconds: 0 },
      vercel_kv_audit: { ok: false, error: "down", staleness_seconds: 0 },
      action_queue: { ok: false, error: "down", staleness_seconds: 0 },
      external_rentcast: { ok: false, error: "401", staleness_seconds: 0 },
    };
    const signals = inferPrioritySignals(brief({}, downHealth));
    const critical = signals.find((s) => s.id === "sources_down_critical");
    expect(critical?.tier).toBe(3);
  });

  it("Quo unresponsive (api_key configured) → tier-2 crier signal", () => {
    const b = brief({
      external_signals: {
        quo: { api_responsive: false, api_key_configured: true },
        rentcast: {
          api_responsive: true,
          burn_rate: { days_until_exhaustion_estimate: null },
        },
      },
    });
    const signals = inferPrioritySignals(b);
    const crier = signals.find((s) => s.id === "quo_down");
    expect(crier?.tier).toBe(2);
    expect(crier?.agent).toBe("crier");
  });

  it("Quo unresponsive + key NOT configured → no signal (not Crier's fault)", () => {
    const b = brief({
      external_signals: {
        quo: { api_responsive: false, api_key_configured: false },
        rentcast: {
          api_responsive: true,
          burn_rate: { days_until_exhaustion_estimate: null },
        },
      },
    });
    const signals = inferPrioritySignals(b);
    expect(signals.find((s) => s.id === "quo_down")).toBeUndefined();
  });
});

describe("inferPrioritySignals — RentCast burn rate", () => {
  it("≤3 days to exhaustion → tier-3 critical", () => {
    const b = brief({
      external_signals: {
        quo: { api_responsive: true, api_key_configured: true },
        rentcast: {
          api_responsive: true,
          burn_rate: { days_until_exhaustion_estimate: 2 },
        },
      },
    });
    const s = inferPrioritySignals(b).find((x) => x.id.startsWith("rentcast"));
    expect(s?.tier).toBe(3);
  });

  it("≤7 days to exhaustion → tier-2 priority", () => {
    const b = brief({
      external_signals: {
        quo: { api_responsive: true, api_key_configured: true },
        rentcast: {
          api_responsive: true,
          burn_rate: { days_until_exhaustion_estimate: 5 },
        },
      },
    });
    const s = inferPrioritySignals(b).find((x) => x.id.startsWith("rentcast"));
    expect(s?.tier).toBe(2);
  });

  it("null days_until_exhaustion → no signal (insufficient burn data)", () => {
    expect(inferPrioritySignals(brief()).find((s) => s.id.startsWith("rentcast"))).toBeUndefined();
  });
});

describe("inferPrioritySignals — self-instrumentation", () => {
  it("MCP over_target_count > 0 → tier-2 maverick signal with P95 in title", () => {
    const b = brief({
      audit_summary: {
        recent_failures: [],
        mcp_call_latency: {
          samples: 3,
          p95_ms: 31_725,
          over_target_count: 1,
          p95_target_ms: 30_000,
        },
      },
    });
    const s = inferPrioritySignals(b).find((x) => x.id === "mcp_latency_over_target");
    expect(s?.tier).toBe(2);
    expect(s?.title).toMatch(/31\.[78]s/);
  });

  it("over_target_count = 0 → no MCP latency signal", () => {
    expect(
      inferPrioritySignals(brief()).find((s) => s.id === "mcp_latency_over_target"),
    ).toBeUndefined();
  });
});

describe("inferPrioritySignals — recent failures + active deals", () => {
  it("recent_failures → tier-2 signals, capped at 5", () => {
    const b = brief({
      audit_summary: {
        recent_failures: [
          { agent: "crier", event: "send_failed", error: "Quo 401", recordId: "rec1", ts: "2026-05-16T01:00:00Z" },
          { agent: "appraiser", event: "phase4a", error: "no comps", recordId: null, ts: "2026-05-16T01:01:00Z" },
          { agent: "sentry", event: "gate_fail", error: "missing PA-12", recordId: "rec2", ts: "2026-05-16T01:02:00Z" },
          { agent: "appraiser", event: "phase4b", error: "no photos", recordId: null, ts: "2026-05-16T01:03:00Z" },
          { agent: "crier", event: "send_failed", error: "Quo 503", recordId: null, ts: "2026-05-16T01:04:00Z" },
          { agent: "scout", event: "match_fail", error: "no buyers", recordId: null, ts: "2026-05-16T01:05:00Z" },
        ],
        mcp_call_latency: {
          samples: 0,
          p95_ms: null,
          over_target_count: 0,
          p95_target_ms: 30_000,
        },
      },
    });
    const failureSignals = inferPrioritySignals(b).filter((s) =>
      s.id.startsWith("failure_"),
    );
    expect(failureSignals.length).toBe(5);
    expect(failureSignals.every((s) => s.tier === 2)).toBe(true);
  });

  it("active_deals → tier-1 informational signal with addresses sample", () => {
    const b = brief({
      active_deals: [
        { id: "rec1", address: "23 Fields Ave" },
        { id: "rec2", address: "Hallbrook" },
        { id: "rec3", address: "Creekmoor" },
        { id: "rec4", address: "Sturtevant" },
      ],
    });
    const s = inferPrioritySignals(b).find((x) => x.id === "active_deals");
    expect(s?.tier).toBe(1);
    expect(s?.title).toMatch(/4 active deals/);
    expect(s?.reason).toMatch(/23 Fields/);
    expect(s?.href).toBe("/pipeline");
  });

  it("open_decisions → tier-1 sentry-attributed signal", () => {
    const b = brief({
      open_decisions: [
        { id: "x1" },
        { id: "x2" },
      ],
    });
    const s = inferPrioritySignals(b).find((x) => x.id === "open_decisions");
    expect(s?.tier).toBe(1);
    expect(s?.agent).toBe("sentry");
  });
});

describe("inferPrioritySignals — sort order", () => {
  it("highest tier signals render first", () => {
    const downHealth = {
      git: { ok: false, error: "timeout", staleness_seconds: 0 },
      airtable_listings: { ok: false, error: "503", staleness_seconds: 0 },
      airtable_spine: { ok: false, error: "503", staleness_seconds: 0 },
      vercel_kv_audit: { ok: false, error: "down", staleness_seconds: 0 },
      action_queue: { ok: false, error: "down", staleness_seconds: 0 },
      external_rentcast: { ok: false, error: "401", staleness_seconds: 0 },
    };
    const b = brief(
      {
        active_deals: [{ id: "rec1", address: "23 Fields" }],
        open_decisions: [{ id: "x1" }],
      },
      downHealth,
    );
    const signals = inferPrioritySignals(b);
    const tiers = signals.map((s) => s.tier);
    // Tier descending: first item must be ≥ second, etc.
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i - 1] >= tiers[i]).toBe(true);
    }
    expect(tiers[0]).toBe(3);
  });
});

describe("maxTier", () => {
  it("returns 0 for empty signals (nothing is happening)", () => {
    expect(maxTier([])).toBe(0);
  });
  it("returns the highest tier across signals", () => {
    expect(
      maxTier([
        { id: "a", tier: 1, title: "x", reason: null, agent: null, href: null },
        { id: "b", tier: 3, title: "y", reason: null, agent: null, href: null },
        { id: "c", tier: 2, title: "z", reason: null, agent: null, href: null },
      ]),
    ).toBe(3);
  });
});

describe("TIER_VISUAL coverage", () => {
  it("defines visual treatment for every tier 0-3", () => {
    const tiers: SeverityTier[] = [0, 1, 2, 3];
    for (const t of tiers) {
      expect(TIER_VISUAL[t]).toBeDefined();
      expect(TIER_VISUAL[t].label).toBeTruthy();
      expect(TIER_VISUAL[t].border).toMatch(/border-/);
      expect(TIER_VISUAL[t].text).toMatch(/text-/);
      expect(TIER_VISUAL[t].dot).toMatch(/bg-/);
    }
  });
});
