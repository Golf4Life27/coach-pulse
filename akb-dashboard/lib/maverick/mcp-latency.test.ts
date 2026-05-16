// @agent: maverick — MCP latency aggregation tests.

import { describe, it, expect } from "vitest";
import type { AuditEntry } from "@/lib/audit-log";
import {
  P95_TARGET_MS,
  computeMcpLatency,
  percentile,
} from "./mcp-latency";

function call(
  ms: number,
  tool: string,
  status: AuditEntry["status"] = "confirmed_success",
): AuditEntry {
  return {
    ts: new Date().toISOString(),
    agent: "maverick",
    event: "mcp_tools_call",
    status,
    inputSummary: { tool, rpc_id: 1 },
    outputSummary: { duration_ms: ms },
  };
}

describe("percentile — nearest-rank", () => {
  it("returns null on empty", () => {
    expect(percentile([], 50)).toBeNull();
  });
  it("returns the lone sample for any p with N=1", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });
  it("p50 of [1,2,3,4,5] is 3", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });
  it("p95 of 100 samples picks the 95th sorted entry", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 95)).toBe(95);
  });
  it("p0 → min, p100 → max", () => {
    expect(percentile([5, 1, 3, 8, 2], 0)).toBe(1);
    expect(percentile([5, 1, 3, 8, 2], 100)).toBe(8);
  });
});

describe("computeMcpLatency — empty / filtering", () => {
  it("returns zero-samples stats on empty input", () => {
    const stats = computeMcpLatency([]);
    expect(stats.samples).toBe(0);
    expect(stats.p50_ms).toBeNull();
    expect(stats.p95_ms).toBeNull();
    expect(stats.over_target_count).toBe(0);
    expect(stats.by_tool).toEqual({});
  });
  it("ignores events that aren't mcp_tools_call", () => {
    const events: AuditEntry[] = [
      {
        ts: "x",
        agent: "maverick",
        event: "mcp_initialize",
        status: "confirmed_success",
        outputSummary: { duration_ms: 1000 },
      },
      call(500, "maverick_load_state"),
    ];
    const stats = computeMcpLatency(events);
    expect(stats.samples).toBe(1);
  });
  it("ignores entries missing duration_ms", () => {
    const events: AuditEntry[] = [
      {
        ts: "x",
        agent: "maverick",
        event: "mcp_tools_call",
        status: "confirmed_success",
        inputSummary: { tool: "maverick_load_state" },
        outputSummary: {},
      },
      call(500, "maverick_load_state"),
    ];
    const stats = computeMcpLatency(events);
    expect(stats.samples).toBe(1);
  });
  it("groups durations by tool name", () => {
    const stats = computeMcpLatency([
      call(1000, "maverick_load_state"),
      call(2000, "maverick_load_state"),
      call(50, "maverick_recall"),
      call(75, "maverick_recall"),
    ]);
    expect(stats.by_tool["maverick_load_state"].samples).toBe(2);
    expect(stats.by_tool["maverick_recall"].samples).toBe(2);
    expect(stats.by_tool["maverick_load_state"].p50_ms).toBe(1000);
    expect(stats.by_tool["maverick_load_state"].p95_ms).toBe(2000);
  });
  it("classifies missing tool name as 'unknown'", () => {
    const events: AuditEntry[] = [
      {
        ts: "x",
        agent: "maverick",
        event: "mcp_tools_call",
        status: "confirmed_success",
        outputSummary: { duration_ms: 100 },
      },
    ];
    expect(computeMcpLatency(events).by_tool["unknown"].samples).toBe(1);
  });
});

describe("computeMcpLatency — over-target detection", () => {
  it("counts events that exceeded P95_TARGET_MS (30s spec ceiling)", () => {
    const stats = computeMcpLatency([
      call(P95_TARGET_MS - 1, "maverick_load_state"), // under
      call(P95_TARGET_MS, "maverick_load_state"),     // exactly at — not over
      call(P95_TARGET_MS + 1, "maverick_load_state"), // over
      call(P95_TARGET_MS + 5000, "maverick_load_state"),
    ]);
    expect(stats.over_target_count).toBe(2);
  });
  it("exposes the target value so the briefing can compare", () => {
    expect(computeMcpLatency([]).p95_target_ms).toBe(30_000);
  });
});

describe("computeMcpLatency — realistic shape", () => {
  it("computes P50/P95/P99 over a mixed-tool workload", () => {
    const events = [
      // load_state mostly cold-path-ish
      ...Array.from({ length: 10 }, () => call(15_000, "maverick_load_state")),
      ...Array.from({ length: 5 }, () => call(19_000, "maverick_load_state")),
      call(45_000, "maverick_load_state"), // outlier above target
      // recall + write_state much faster
      ...Array.from({ length: 20 }, () => call(200, "maverick_recall")),
      ...Array.from({ length: 10 }, () => call(800, "maverick_write_state")),
    ];
    const stats = computeMcpLatency(events);
    expect(stats.samples).toBe(46);
    expect(stats.over_target_count).toBe(1);
    expect(stats.by_tool["maverick_load_state"].p95_ms).toBeGreaterThanOrEqual(19_000);
    expect(stats.by_tool["maverick_recall"].p50_ms).toBe(200);
  });
});
