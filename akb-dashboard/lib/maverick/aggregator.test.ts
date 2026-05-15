// @agent: maverick — aggregator pure-helper tests.
//
// The full buildBriefing() function does real I/O against 9 sources
// + Anthropic API and is exercised by the deployed-endpoint smoke
// test. These tests target the pure helpers that the orchestration
// composes from — the parts that determine correctness.

import { describe, it, expect } from "vitest";
import {
  computeDeployBehindHead,
  computeCycleDaysElapsed,
  buildStalenessWarnings,
} from "./aggregator";
import type { SourceHealth } from "./briefing";
import type { SourceName } from "./types";

describe("computeDeployBehindHead", () => {
  it("returns false when SHAs match exactly", () => {
    expect(computeDeployBehindHead("abc123", "abc123")).toBe(false);
  });

  it("returns true when SHAs differ", () => {
    expect(computeDeployBehindHead("abc123", "def456")).toBe(true);
  });

  it("returns null when either SHA is missing (can't decide)", () => {
    expect(computeDeployBehindHead(null, "abc")).toBeNull();
    expect(computeDeployBehindHead("abc", null)).toBeNull();
    expect(computeDeployBehindHead(undefined, undefined)).toBeNull();
  });
});

describe("computeCycleDaysElapsed", () => {
  it("returns 0 on the first day of the month UTC", () => {
    expect(computeCycleDaysElapsed(new Date(Date.UTC(2026, 4, 1, 12, 0, 0)))).toBe(0);
  });

  it("returns 14 on the 15th of the month", () => {
    expect(computeCycleDaysElapsed(new Date(Date.UTC(2026, 4, 15, 0, 0, 0)))).toBe(14);
  });

  it("handles month boundaries — first-of-month at midnight = 0", () => {
    expect(computeCycleDaysElapsed(new Date(Date.UTC(2026, 5, 1, 0, 0, 0)))).toBe(0);
  });
});

describe("buildStalenessWarnings", () => {
  function h(over: Partial<SourceHealth>): SourceHealth {
    return {
      source: "git",
      ok: true,
      latency_ms: 100,
      staleness_seconds: 0,
      served_from_cache: false,
      error: null,
      ...over,
    } as SourceHealth;
  }

  it("returns empty list when all sources are ok and fresh", () => {
    const sh: Record<SourceName, SourceHealth> = {
      git: h({ source: "git" }),
      airtable_listings: h({ source: "airtable_listings" }),
      airtable_spine: h({ source: "airtable_spine" }),
      vercel_kv_audit: h({ source: "vercel_kv_audit" }),
      codebase_metadata: h({ source: "codebase_metadata" }),
      action_queue: h({ source: "action_queue" }),
      external_rentcast: h({ source: "external_rentcast" }),
      external_quo: h({ source: "external_quo" }),
      external_vercel: h({ source: "external_vercel" }),
    };
    expect(buildStalenessWarnings(sh)).toEqual([]);
  });

  it("surfaces every non-ok source with its error message", () => {
    const sh: Record<SourceName, SourceHealth> = {
      git: h({ source: "git", ok: false, error: "timeout after 5000ms" }),
      airtable_listings: h({ source: "airtable_listings" }),
      airtable_spine: h({ source: "airtable_spine", ok: false, error: "Airtable 503" }),
      vercel_kv_audit: h({ source: "vercel_kv_audit" }),
      codebase_metadata: h({ source: "codebase_metadata" }),
      action_queue: h({ source: "action_queue" }),
      external_rentcast: h({ source: "external_rentcast" }),
      external_quo: h({ source: "external_quo" }),
      external_vercel: h({ source: "external_vercel" }),
    };
    const ws = buildStalenessWarnings(sh);
    expect(ws).toEqual([
      "git: timeout after 5000ms",
      "airtable_spine: Airtable 503",
    ]);
  });

  it("flags sources whose staleness exceeds 5 minutes (300s)", () => {
    const sh: Record<SourceName, SourceHealth> = {
      git: h({ source: "git" }),
      airtable_listings: h({ source: "airtable_listings", staleness_seconds: 400 }),
      airtable_spine: h({ source: "airtable_spine" }),
      vercel_kv_audit: h({ source: "vercel_kv_audit" }),
      codebase_metadata: h({ source: "codebase_metadata" }),
      action_queue: h({ source: "action_queue" }),
      external_rentcast: h({ source: "external_rentcast" }),
      external_quo: h({ source: "external_quo" }),
      external_vercel: h({ source: "external_vercel" }),
    };
    expect(buildStalenessWarnings(sh)).toEqual([
      "airtable_listings: data is 6min old",
    ]);
  });

  it("uses fallback 'unreachable' phrase when ok=false but error is null", () => {
    const sh: Record<SourceName, SourceHealth> = {
      git: h({ source: "git", ok: false, error: null }),
      airtable_listings: h({ source: "airtable_listings" }),
      airtable_spine: h({ source: "airtable_spine" }),
      vercel_kv_audit: h({ source: "vercel_kv_audit" }),
      codebase_metadata: h({ source: "codebase_metadata" }),
      action_queue: h({ source: "action_queue" }),
      external_rentcast: h({ source: "external_rentcast" }),
      external_quo: h({ source: "external_quo" }),
      external_vercel: h({ source: "external_vercel" }),
    };
    expect(buildStalenessWarnings(sh)).toEqual(["git: unreachable"]);
  });
});
