// Maverick — MCP per-call latency stats.
// @agent: maverick (Day 5)
//
// Pure aggregation over audit-log events. The MCP route already
// captures `duration_ms` in the `mcp_tools_call` audit entry's
// outputSummary (Day 3 instrumentation). This module rolls those
// observations into P50/P95/P99 stats — the briefing's own
// self-instrumentation per Spec v1.2 §6.2 (P95 ≤ 30s target).
//
// Day 5 design rationale (vs synthetic benchmark): real production
// traffic accumulates measurements naturally. Maverick observes
// himself; latency drift surfaces in the briefing instead of needing
// a separate dashboard.

import type { AuditEntry } from "@/lib/audit-log";

export interface ToolLatency {
  samples: number;
  p50_ms: number | null;
  p95_ms: number | null;
}

export interface McpLatencyStats {
  samples: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  by_tool: Record<string, ToolLatency>;
  /** Number of mcp_tools_call events that exceeded the P95 ≤ 30s spec target. */
  over_target_count: number;
  /** Spec v1.2 §6.2 target. Surfaced so the briefing can mark drift. */
  p95_target_ms: number;
}

export const P95_TARGET_MS = 30_000;
const MCP_CALL_EVENT = "mcp_tools_call";

/**
 * Compute latency stats from a slice of audit events. Pure — no I/O.
 * Filters to mcp_tools_call events with a numeric `duration_ms` in
 * outputSummary + a string `tool` in inputSummary.
 */
export function computeMcpLatency(events: AuditEntry[]): McpLatencyStats {
  const durations: number[] = [];
  const byTool: Record<string, number[]> = {};

  for (const e of events) {
    if (e.event !== MCP_CALL_EVENT) continue;
    const out = e.outputSummary as { duration_ms?: unknown } | undefined;
    const inp = e.inputSummary as { tool?: unknown } | undefined;
    const duration = out?.duration_ms;
    if (typeof duration !== "number" || !Number.isFinite(duration)) continue;
    durations.push(duration);
    const tool = typeof inp?.tool === "string" ? inp.tool : "unknown";
    (byTool[tool] ??= []).push(duration);
  }

  const by_tool: Record<string, ToolLatency> = {};
  for (const [tool, samples] of Object.entries(byTool)) {
    by_tool[tool] = {
      samples: samples.length,
      p50_ms: percentile(samples, 50),
      p95_ms: percentile(samples, 95),
    };
  }

  return {
    samples: durations.length,
    p50_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    p99_ms: percentile(durations, 99),
    by_tool,
    over_target_count: durations.filter((d) => d > P95_TARGET_MS).length,
    p95_target_ms: P95_TARGET_MS,
  };
}

/**
 * Percentile via the nearest-rank method. Returns null on empty input.
 *
 * Notes:
 *  - p in [0, 100]
 *  - Uses ceil(p/100 * N) - 1 indexing for stable behavior on small N
 *    (e.g. p95 of 1 sample returns that sample, p95 of 20 samples
 *    returns the 19th sorted entry).
 */
export function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  if (p <= 0) return Math.min(...samples);
  if (p >= 100) return Math.max(...samples);
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}
