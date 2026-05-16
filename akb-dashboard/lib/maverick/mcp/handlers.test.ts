// @agent: maverick — method-dispatch handler tests.
//
// Production handlers wire buildBriefing as a dependency. Tests
// inject a stub so the dispatch logic is exercised without making
// real Airtable / Anthropic / GitHub calls.

import { describe, it, expect, vi } from "vitest";
import {
  dispatch,
  handleInitialize,
  handleToolsList,
  handleToolsCall,
  runLoadState,
  runWriteState,
  runRecall,
  type HandlerDeps,
} from "./handlers";
import type { Briefing } from "../briefing";
import {
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_INVALID_PARAMS,
  MCP_TOOL_EXECUTION_ERROR,
} from "./protocol";

// ──────────────── shared test fixtures ────────────────

function stubBriefing(over: Partial<Briefing> = {}): Briefing {
  return {
    generated_at: "2026-05-15T18:00:00Z",
    duration_ms: 12340,
    narrative: "Welcome back. Test narrative.",
    narrative_synthesized: true,
    narrative_error: null,
    structured: {
      generated_at: "2026-05-15T18:00:00Z",
      duration_ms: 12340,
      since: "2026-05-14T18:00:00Z",
      build_state: {
        branch: "test",
        branch_resolved: true,
        latest_commit: null,
        commits_since_count: 0,
        commits_since: [],
        files_changed_since: [],
        tests: { count: 144, source: "prebuild_artifact", ci_state: "unknown", ci_sha: null },
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
          api_responsive: true,
          api_key_configured: true,
          monthly_cap: 1000,
          reset_date_utc: "2026-06-01",
          days_until_reset: 17,
          probe_latency_ms: 100,
          burn_rate: {
            pricing_calls_in_window: 0,
            estimated_calls_in_window: 0,
            window_hours: 24,
            burn_rate_per_day: 0,
            days_until_exhaustion_estimate: null,
            estimated_calls_remaining: 1000,
          },
        },
        quo: {
          api_responsive: true,
          api_key_configured: true,
          most_recent_outbound_at: null,
          most_recent_inbound_at: null,
          messages_last_24h: 0,
        },
        vercel: {
          api_token_configured: true,
          latest_deploy_id: null,
          latest_deploy_url: null,
          latest_deploy_state: "READY",
          latest_deploy_sha: null,
          latest_deploy_short_sha: null,
          latest_deploy_branch: null,
          latest_deploy_ready_at: null,
          latest_deploy_created_at: null,
          active_branch_observed: "test",
        },
      },
      staleness_warnings: [],
    },
    source_health: {
      git: { source: "git", ok: true, latency_ms: 50, staleness_seconds: 0, served_from_cache: false, error: null },
      airtable_listings: { source: "airtable_listings", ok: true, latency_ms: 3000, staleness_seconds: 0, served_from_cache: false, error: null },
      airtable_spine: { source: "airtable_spine", ok: true, latency_ms: 200, staleness_seconds: 0, served_from_cache: false, error: null },
      vercel_kv_audit: { source: "vercel_kv_audit", ok: true, latency_ms: 50, staleness_seconds: 0, served_from_cache: false, error: null },
      codebase_metadata: { source: "codebase_metadata", ok: true, latency_ms: 40, staleness_seconds: 0, served_from_cache: false, error: null },
      action_queue: { source: "action_queue", ok: true, latency_ms: 200, staleness_seconds: 0, served_from_cache: false, error: null },
      external_rentcast: { source: "external_rentcast", ok: true, latency_ms: 200, staleness_seconds: 0, served_from_cache: false, error: null },
      external_quo: { source: "external_quo", ok: true, latency_ms: 100, staleness_seconds: 0, served_from_cache: false, error: null },
      external_vercel: { source: "external_vercel", ok: true, latency_ms: 50, staleness_seconds: 0, served_from_cache: false, error: null },
    },
    ...over,
  };
}

function deps(briefing?: Briefing): HandlerDeps {
  return {
    buildBriefing: vi.fn().mockResolvedValue(briefing ?? stubBriefing()),
    writeState: vi.fn().mockResolvedValue({
      written: true as const,
      spine_record_id: "recSTUB0000001",
      audit_event_id: "2026-05-15T18:00:00.000Z",
    }),
    recall: vi.fn().mockResolvedValue({
      results: [],
      truncated_to_n: 0,
      searched_sources: ["spine", "audit"],
    }),
  };
}

// ──────────────── initialize ────────────────

describe("handleInitialize", () => {
  it("returns protocolVersion + capabilities.tools + serverInfo + instructions", () => {
    const r = handleInitialize(1, { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "0.0.1" } });
    expect("result" in r).toBe(true);
    if (!("result" in r)) return;
    const result = r.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toMatchObject({ tools: { listChanged: false } });
    expect(result.serverInfo).toMatchObject({ name: "maverick", version: "1.0.0" });
    expect(typeof result.instructions).toBe("string");
  });

  it("echoes the client's requested protocolVersion when valid", () => {
    const r = handleInitialize(1, { protocolVersion: "2024-11-05" });
    if (!("result" in r)) throw new Error("expected result");
    expect((r.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
  });

  it("falls back to server default when client omits protocolVersion", () => {
    const r = handleInitialize(1, {});
    if (!("result" in r)) throw new Error("expected result");
    expect(typeof (r.result as { protocolVersion: string }).protocolVersion).toBe("string");
  });

  it("instructions reference the Continuity Layer Spec for client model context", () => {
    const r = handleInitialize(1, {});
    if (!("result" in r)) throw new Error("expected result");
    const instructions = (r.result as { instructions: string }).instructions;
    expect(instructions).toMatch(/maverick_load_state/);
    expect(instructions).toMatch(/Spec v1\.1/);
  });
});

// ──────────────── tools/list ────────────────

describe("handleToolsList", () => {
  it("returns the tool catalog", () => {
    const r = handleToolsList(2);
    if (!("result" in r)) throw new Error("expected result");
    const result = r.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools[0].name).toBe("maverick_load_state");
  });
});

// ──────────────── tools/call ────────────────

describe("handleToolsCall — validation", () => {
  it("rejects non-object params with -32602", async () => {
    const r = await handleToolsCall(3, "string params", deps());
    expect("error" in r && r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it("rejects missing tool name with -32602", async () => {
    const r = await handleToolsCall(3, { arguments: {} }, deps());
    expect("error" in r && r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it("rejects unknown tool name with -32602", async () => {
    const r = await handleToolsCall(3, { name: "maverick_unknown", arguments: {} }, deps());
    expect("error" in r && r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
    if ("error" in r) expect(r.error.message).toMatch(/unknown tool/);
  });
});

describe("runLoadState", () => {
  it("default format=narrative returns the briefing.narrative in a single text content block", async () => {
    const d = deps(stubBriefing({ narrative: "Hello narrative" }));
    const r = await runLoadState(4, {}, d);
    if (!("result" in r)) throw new Error("expected result");
    const result = r.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("Hello narrative");
    // format=narrative omits structuredContent.
    expect("structuredContent" in result).toBe(false);
  });

  it("format=structured returns structuredContent + omits the text block", async () => {
    const r = await runLoadState(4, { format: "structured" }, deps());
    if (!("result" in r)) throw new Error("expected result");
    const result = r.result as { content: unknown[]; structuredContent: unknown };
    expect(result.content).toHaveLength(0);
    expect(result.structuredContent).toBeTruthy();
  });

  it("format=both returns BOTH the narrative text block AND structuredContent", async () => {
    const r = await runLoadState(4, { format: "both" }, deps());
    if (!("result" in r)) throw new Error("expected result");
    const result = r.result as { content: Array<{ text: string }>; structuredContent: unknown };
    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toBeTruthy();
  });

  it("rejects invalid format value with -32602", async () => {
    const r = await runLoadState(4, { format: "yaml" }, deps());
    expect("error" in r && r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it("threads skip_cache=true through to buildBriefing", async () => {
    const d = deps();
    await runLoadState(4, { skip_cache: true }, d);
    expect(d.buildBriefing).toHaveBeenCalledWith(
      expect.objectContaining({ skipCache: true }),
    );
  });

  it("threads since parameter through to buildBriefing", async () => {
    const d = deps();
    await runLoadState(4, { since: "2026-05-14T00:00:00Z" }, d);
    expect(d.buildBriefing).toHaveBeenCalledWith(
      expect.objectContaining({ since: "2026-05-14T00:00:00Z" }),
    );
  });

  it("wraps buildBriefing errors in -32001 MCP_TOOL_EXECUTION_ERROR", async () => {
    const d: HandlerDeps = {
      buildBriefing: vi.fn().mockRejectedValue(new Error("airtable 503")),
      writeState: vi.fn(),
      recall: vi.fn(),
    };
    const r = await runLoadState(4, {}, d);
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.code).toBe(MCP_TOOL_EXECUTION_ERROR);
      expect(r.error.message).toMatch(/airtable 503/);
    }
  });

  it("flags isError=true when synthesis failed AND >3 sources are down", async () => {
    const b = stubBriefing({
      narrative_synthesized: false,
      narrative_error: "synthesis timeout",
    });
    // Knock 4 sources offline.
    b.source_health.airtable_listings.ok = false;
    b.source_health.airtable_spine.ok = false;
    b.source_health.vercel_kv_audit.ok = false;
    b.source_health.external_quo.ok = false;
    const r = await runLoadState(4, { format: "both" }, deps(b));
    if (!("result" in r)) throw new Error("expected result");
    expect((r.result as { isError?: boolean }).isError).toBe(true);
  });

  it("does NOT flag isError when synthesis failed but most sources are healthy", async () => {
    const b = stubBriefing({ narrative_synthesized: false, narrative_error: "synthesis timeout" });
    const r = await runLoadState(4, { format: "both" }, deps(b));
    if (!("result" in r)) throw new Error("expected result");
    expect((r.result as { isError?: boolean }).isError).toBeUndefined();
  });
});

// ──────────────── dispatch (method routing) ────────────────

describe("dispatch — method routing", () => {
  it("routes initialize → handleInitialize", async () => {
    const r = await dispatch("initialize", { protocolVersion: "2025-06-18" }, 1, deps());
    expect(r && "result" in r).toBe(true);
  });

  it("routes tools/list → handleToolsList", async () => {
    const r = await dispatch("tools/list", {}, 2, deps());
    expect(r && "result" in r).toBe(true);
  });

  it("routes tools/call → handleToolsCall", async () => {
    const r = await dispatch("tools/call", { name: "maverick_load_state", arguments: {} }, 3, deps());
    expect(r && "result" in r).toBe(true);
  });

  it("returns null for notifications/initialized (no response per spec)", async () => {
    const r = await dispatch("notifications/initialized", {}, null, deps());
    expect(r).toBeNull();
  });

  it("answers ping with empty result (MCP keepalive convention)", async () => {
    const r = await dispatch("ping", {}, 5, deps());
    if (!r || !("result" in r)) throw new Error("expected result");
    expect(r.result).toEqual({});
  });

  it("returns -32601 method not found for unknown methods", async () => {
    const r = await dispatch("custom/unknown", {}, 9, deps());
    if (!r || !("error" in r)) throw new Error("expected error");
    expect(r.error.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
  });

  it("routes tools/call → maverick_write_state via handleToolsCall", async () => {
    const d = deps();
    const r = await dispatch(
      "tools/call",
      {
        name: "maverick_write_state",
        arguments: { event_type: "decision", title: "T", description: "D" },
      },
      10,
      d,
    );
    expect(r && "result" in r).toBe(true);
    expect(d.writeState).toHaveBeenCalledTimes(1);
  });

  it("routes tools/call → maverick_recall via handleToolsCall", async () => {
    const d = deps();
    const r = await dispatch("tools/call", { name: "maverick_recall", arguments: { query: "x" } }, 11, d);
    expect(r && "result" in r).toBe(true);
    expect(d.recall).toHaveBeenCalledTimes(1);
  });
});

// ──────────────── runWriteState ────────────────

describe("runWriteState", () => {
  it("returns text + structuredContent on successful write", async () => {
    const d = deps();
    const r = await runWriteState(
      1,
      { event_type: "decision", title: "Day 4 ships", description: "write_state + recall" },
      d,
    );
    if (!("result" in r)) throw new Error("expected result");
    const result = r.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { spine_record_id: string; audit_event_id: string };
    };
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toMatch(/Day 4 ships/);
    expect(result.structuredContent.spine_record_id).toBe("recSTUB0000001");
  });

  it("rejects missing required args with -32602", async () => {
    const r = await runWriteState(1, {}, deps());
    expect("error" in r && r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it("rejects unknown event_type with -32602 + helpful message", async () => {
    const r = await runWriteState(
      1,
      { event_type: "rollback", title: "x", description: "x" },
      deps(),
    );
    if (!("error" in r)) throw new Error("expected error");
    expect(r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
    expect(r.error.message).toMatch(/event_type must be one of/);
  });

  it("rejects malformed related_spine_decision", async () => {
    const r = await runWriteState(
      1,
      {
        event_type: "principle_amendment",
        title: "x",
        description: "x",
        related_spine_decision: "not-a-rec-id",
      },
      deps(),
    );
    expect("error" in r && r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it("rejects attribution_agent outside the roster", async () => {
    const r = await runWriteState(
      1,
      {
        event_type: "decision",
        title: "x",
        description: "x",
        attribution_agent: "rogue",
      },
      deps(),
    );
    expect("error" in r && r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it("wraps writeState errors in MCP_TOOL_EXECUTION_ERROR", async () => {
    const d = deps();
    d.writeState = vi.fn().mockRejectedValue(new Error("Airtable 503"));
    const r = await runWriteState(
      1,
      { event_type: "decision", title: "x", description: "x" },
      d,
    );
    if (!("error" in r)) throw new Error("expected error");
    expect(r.error.code).toBe(-32001);
    expect(r.error.message).toMatch(/Airtable 503/);
  });

  it("threads validated args through to writeState", async () => {
    const d = deps();
    await runWriteState(
      1,
      {
        event_type: "build_event",
        title: "Day 4 ships",
        description: "write_state + recall live",
        reasoning: "Spec v1.1 §5 Step 4",
        attribution_agent: "maverick",
      },
      d,
    );
    expect(d.writeState).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "build_event",
        title: "Day 4 ships",
        description: "write_state + recall live",
        reasoning: "Spec v1.1 §5 Step 4",
        attribution_agent: "maverick",
      }),
    );
  });
});

// ──────────────── runRecall ────────────────

describe("runRecall", () => {
  it("returns text summary + structuredContent on successful query", async () => {
    const d = deps();
    d.recall = vi.fn().mockResolvedValue({
      results: [
        { source: "spine", record_id: "recSPINE1", summary: "2026-05-15 — Test", full_data: {} },
        { source: "audit", record_id: "2026-05-15T18:00:00Z", summary: "maverick/load_state", full_data: {} },
      ],
      truncated_to_n: 0,
      searched_sources: ["spine", "audit"],
    });
    const r = await runRecall(1, { query: "test" }, d);
    if (!("result" in r)) throw new Error("expected result");
    const result = r.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { results: unknown[] };
    };
    expect(result.content[0].text).toMatch(/Found 2 match\(es\)/);
    expect(result.content[0].text).toMatch(/spine\/recSPINE1/);
    expect(result.content[0].text).toMatch(/audit\/2026-05-15T18:00:00Z/);
    expect(Array.isArray(result.structuredContent.results)).toBe(true);
  });

  it("surfaces truncation count in the text header", async () => {
    const d = deps();
    d.recall = vi.fn().mockResolvedValue({
      results: [{ source: "spine", record_id: "r1", summary: "x", full_data: {} }],
      truncated_to_n: 42,
      searched_sources: ["spine", "audit"],
    });
    const r = await runRecall(1, { query: "x" }, d);
    if (!("result" in r)) throw new Error("expected result");
    const text = (r.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toMatch(/\+42 more truncated/);
  });

  it("rejects missing query with -32602", async () => {
    const r = await runRecall(1, {}, deps());
    expect("error" in r && r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it("rejects malformed since with -32602", async () => {
    const r = await runRecall(1, { query: "x", since: "yesterday" }, deps());
    expect("error" in r && r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it("rejects unknown sources entry with -32602", async () => {
    const r = await runRecall(1, { query: "x", sources: ["spine", "rogue_source"] }, deps());
    expect("error" in r && r.error.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it("wraps recall errors in MCP_TOOL_EXECUTION_ERROR", async () => {
    const d = deps();
    d.recall = vi.fn().mockRejectedValue(new Error("KV down"));
    const r = await runRecall(1, { query: "x" }, d);
    if (!("error" in r)) throw new Error("expected error");
    expect(r.error.code).toBe(-32001);
  });

  it("threads validated args through to recall", async () => {
    const d = deps();
    await runRecall(
      1,
      { query: "65% rule", since: "2026-05-01T00:00:00Z", sources: ["spine"] },
      d,
    );
    expect(d.recall).toHaveBeenCalledWith({
      query: "65% rule",
      since: "2026-05-01T00:00:00Z",
      until: undefined,
      sources: ["spine"],
    });
  });
});
