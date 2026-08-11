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

const DEFAULT_TIMEOUT_MS = 4_000;
// 2026-08-08: was 200 — on a busy day 200 events span ~3h, so any consumer
// treating this as "the last 24h" (the RentCast burn meter did) undercounts
// by whatever the truncation hides. 5000 matches the honest spend counter
// (lib/spend/derive via appraiser-backfill). Timeout raised 2s→4s for the
// larger lrange.
const DEFAULT_LIMIT = 5_000;

export interface RecentAuditEvent {
  agent: string;
  event: string;
  status: "confirmed_success" | "confirmed_failure" | "uncertain";
  ts: string;
  recordId: string | null;
}

export interface VercelKvAuditState {
  total_events_since: number;
  recent_events_by_agent: Record<string, number>;
  /**
   * Slim recent-events list across all agents, newest first. Phase 9.4
   * factory-floor rooms filter by `agent` client-side to render each
   * agent's last-N activity. Capped at 50 to limit synthesizer prompt
   * inflation; full audit log remains queryable via /api/admin/audit-summary.
   */
  recent_events: RecentAuditEvent[];
  recent_failures: Array<{
    agent: string;
    event: string;
    error: string | null;
    recordId: string | null;
    ts: string;
  }>;
  oldest_event_ts: string | null;
  newest_event_ts: string | null;
  /** True when the KV read returned a full page (events hit the read limit),
   *  meaning older events exist that this state cannot see. Consumers that
   *  rate-over-a-window (the RentCast burn meter) must clamp their window to
   *  the actual data span when this is set — dividing a truncated count by
   *  the full window is how the meter reported 30/day while the vendor was
   *  billing ~197/day (2026-08-08). Optional for fixture compatibility;
   *  absent means "not truncated". */
  read_truncated?: boolean;
  mcp_call_latency: McpLatencyStats;
}

export async function fetchVercelKvAuditState(
  opts: FetchOpts = {},
): Promise<SourceResult<VercelKvAuditState>> {
  return runWithTimeout(
    { source: "vercel_kv_audit", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async () => {
      const events = await readRecentFromKv(DEFAULT_LIMIT);
      return summarizeEvents(events, opts.since, DEFAULT_LIMIT);
    },
  );
}

/**
 * Pure summarizer — extracted so tests can hit the aggregation logic
 * without stubbing KV. The fetcher is the thin I/O wrapper. readLimit
 * is the limit the KV read was made with — a full page (pre-filter)
 * marks the state read_truncated.
 */
export function summarizeEvents(
  events: AuditEntry[],
  since?: Date,
  readLimit?: number,
): VercelKvAuditState {
  const sinceMs = since?.getTime() ?? 0;
  const filtered = events.filter((e) => {
    if (!sinceMs) return true;
    const t = new Date(e.ts).getTime();
    return !isNaN(t) && t >= sinceMs;
  });

  const byAgent: Record<string, number> = {};
  const failures: VercelKvAuditState["recent_failures"] = [];
  const recentEvents: RecentAuditEvent[] = [];
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
    if (recentEvents.length < 50) {
      recentEvents.push({
        agent: e.agent,
        event: e.event,
        status: e.status,
        ts: e.ts,
        recordId: e.recordId ?? null,
      });
    }
  }

  return {
    total_events_since: filtered.length,
    recent_events_by_agent: byAgent,
    recent_events: recentEvents,
    recent_failures: failures.slice(0, 25),
    oldest_event_ts: filtered.length > 0 ? filtered[filtered.length - 1].ts : null,
    newest_event_ts: filtered.length > 0 ? filtered[0].ts : null,
    read_truncated: readLimit != null && events.length >= readLimit,
    mcp_call_latency: computeMcpLatency(filtered),
  };
}

// Re-exported for endpoints that need to construct a sentinel failure
// without invoking the fetcher (e.g., when env config is known absent).
export function vercelKvAuditUnavailable(reason: string): SourceResult<VercelKvAuditState> {
  return failResult("vercel_kv_audit", reason, 0);
}
