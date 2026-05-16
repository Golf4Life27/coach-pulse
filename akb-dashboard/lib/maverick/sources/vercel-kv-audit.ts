// Maverick source — Vercel KV audit log.
// @agent: maverick
//
// Reads recent audit events from KV via lib/audit-log.readRecentFromKv.
// Surfaces: events grouped by agent, recent failures, total since.
//
// Budget: 2s (KV is sub-100ms locally; allow headroom for cold lambda).
// Spec v1.1 §5 Step 1.

import { readRecentFromKv, type AuditEntry } from "@/lib/audit-log";
import { computeMcpLatency, type McpLatencyStats } from "../mcp-latency";
import { runWithTimeout } from "../timeout";
import { failResult, type FetchOpts, type SourceResult } from "../types";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_LIMIT = 200;

export interface VercelKvAuditState {
  total_events_since: number;
  recent_events_by_agent: Record<string, number>;
  recent_failures: Array<{
    agent: string;
    event: string;
    error: string | null;
    recordId: string | null;
    ts: string;
  }>;
  oldest_event_ts: string | null;
  newest_event_ts: string | null;
  mcp_call_latency: McpLatencyStats;
}

export async function fetchVercelKvAuditState(
  opts: FetchOpts = {},
): Promise<SourceResult<VercelKvAuditState>> {
  return runWithTimeout(
    { source: "vercel_kv_audit", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async () => {
      const events = await readRecentFromKv(DEFAULT_LIMIT);
      return summarizeEvents(events, opts.since);
    },
  );
}

/**
 * Pure summarizer — extracted so tests can hit the aggregation logic
 * without stubbing KV. The fetcher is the thin I/O wrapper.
 */
export function summarizeEvents(
  events: AuditEntry[],
  since?: Date,
): VercelKvAuditState {
  const sinceMs = since?.getTime() ?? 0;
  const filtered = events.filter((e) => {
    if (!sinceMs) return true;
    const t = new Date(e.ts).getTime();
    return !isNaN(t) && t >= sinceMs;
  });

  const byAgent: Record<string, number> = {};
  const failures: VercelKvAuditState["recent_failures"] = [];
  for (const e of filtered) {
    byAgent[e.agent] = (byAgent[e.agent] ?? 0) + 1;
    if (e.status === "confirmed_failure") {
      failures.push({
        agent: e.agent,
        event: e.event,
        error: e.error ?? null,
        recordId: e.recordId ?? null,
        ts: e.ts,
      });
    }
  }

  return {
    total_events_since: filtered.length,
    recent_events_by_agent: byAgent,
    recent_failures: failures.slice(0, 25),
    oldest_event_ts: filtered.length > 0 ? filtered[filtered.length - 1].ts : null,
    newest_event_ts: filtered.length > 0 ? filtered[0].ts : null,
    mcp_call_latency: computeMcpLatency(filtered),
  };
}

// Re-exported for endpoints that need to construct a sentinel failure
// without invoking the fetcher (e.g., when env config is known absent).
export function vercelKvAuditUnavailable(reason: string): SourceResult<VercelKvAuditState> {
  return failResult("vercel_kv_audit", reason, 0);
}
