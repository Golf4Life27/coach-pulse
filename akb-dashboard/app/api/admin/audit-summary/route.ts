// GET /api/admin/audit-summary
//
// Aggregates the agent:audit list in Vercel KV by status. Lets a human
// (or the Vercel MCP) verify the three-status distribution from the
// Positive Confirmation Principle without spelunking individual entries.
//
// Response shape:
//   {
//     total_in_kv,
//     in_memory_ring_size,
//     by_status: { confirmed_success, confirmed_failure, uncertain },
//     by_status_pct: { ... },
//     uncertain_stale,    // uncertain entries older than 5 minutes
//     by_agent_event,     // top combinations
//     sample_entries: { confirmed_success, confirmed_failure, uncertain }
//   }
//
// No auth — the data here is operational metadata, not PII or secrets.
// Move behind admin auth if/when the dashboard starts exposing it.

import { NextResponse } from "next/server";
import { readMemoryRing, readUncertain, type AuditEntry } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 15;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvRead(limit: number): Promise<AuditEntry[]> {
  if (!KV_URL || !KV_TOKEN) return [];
  const res = await fetch(`${KV_URL}/lrange/agent:audit/0/${limit - 1}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`KV LRANGE ${res.status}: ${await res.text().catch(() => "(no body)")}`);
  }
  const data = (await res.json()) as { result?: string[] };
  if (!Array.isArray(data.result)) return [];
  return data.result.flatMap<AuditEntry>((s) => {
    try {
      // Upstash double-encodes — string in the list is the JSON we pushed.
      const parsed = JSON.parse(s);
      return [parsed as AuditEntry];
    } catch {
      return [];
    }
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 5000);

  let kvEntries: AuditEntry[] = [];
  let kvError: string | null = null;
  let kvAvailable = Boolean(KV_URL && KV_TOKEN);

  if (kvAvailable) {
    try {
      kvEntries = await kvRead(limit);
    } catch (err) {
      kvError = String(err);
      kvAvailable = false;
    }
  }

  const ringEntries = readMemoryRing(limit);
  const source = kvEntries.length > 0 ? "kv" : "memory_ring";
  const entries = kvEntries.length > 0 ? kvEntries : ringEntries;

  const by_status = {
    confirmed_success: 0,
    confirmed_failure: 0,
    uncertain: 0,
  };
  const by_agent_event: Record<string, number> = {};
  const sample_entries: Record<string, AuditEntry | null> = {
    confirmed_success: null,
    confirmed_failure: null,
    uncertain: null,
  };

  for (const e of entries) {
    if (e.status in by_status) {
      by_status[e.status]++;
      if (sample_entries[e.status] == null) sample_entries[e.status] = e;
    }
    const key = `${e.agent}:${e.event}`;
    by_agent_event[key] = (by_agent_event[key] || 0) + 1;
  }

  const total = entries.length;
  const by_status_pct = {
    confirmed_success: total ? +(by_status.confirmed_success / total * 100).toFixed(1) : 0,
    confirmed_failure: total ? +(by_status.confirmed_failure / total * 100).toFixed(1) : 0,
    uncertain: total ? +(by_status.uncertain / total * 100).toFixed(1) : 0,
  };

  const topAgentEvents = Object.entries(by_agent_event)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, v]) => ({ key: k, count: v }));

  return NextResponse.json({
    source,
    kv_available: kvAvailable,
    kv_error: kvError,
    total_in_source: total,
    in_memory_ring_size: ringEntries.length,
    by_status,
    by_status_pct,
    top_agent_events: topAgentEvents,
    uncertain_stale_count: readUncertain(5 * 60_000).length,
    sample_entries,
    queried_at: new Date().toISOString(),
  });
}
