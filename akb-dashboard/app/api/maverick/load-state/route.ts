// Maverick state aggregator endpoint — `/api/maverick/load-state`.
// @agent: maverick (Day 2)
//
// Single Vercel function that any Claude session can call at session
// open to load the entire operational state of the Inevitable
// system in <30s (P95 target per Spec v1.1 §8.1).
//
// Thin handler over lib/maverick/aggregator.buildBriefing. The
// aggregator owns cache, parallel fetch, cross-source synthesis,
// and Claude API synthesis with template fallback.
//
// Auth: bearer-token via MAVERICK_MCP_TOKEN. v1 uses one shared
// token across all caller types (claude.ai web, Claude Code,
// future products). Per-source tokens deferred to v1.1+.
//
// Query params:
//   - since=ISO         — override the 24h-ago default window
//   - format=narrative|structured|both (default: both)
//   - cache=skip        — bypass the 90s stale-while-revalidate cache
//                         (diagnostic / manual force-refresh)
//
// Spec v1.1 §5 Step 1. Gate 2: P95 ≤ 30s on live data.

import { NextResponse } from "next/server";
import { buildBriefing } from "@/lib/maverick/aggregator";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby ceiling per AGENTS.md

const MAVERICK_MCP_TOKEN = process.env.MAVERICK_MCP_TOKEN;

export async function GET(req: Request) {
  const t0 = Date.now();

  // Auth — bearer-token if configured. v1 leaves token-less mode for
  // local dev / first deploy; the MCP server (Day 3) tightens this.
  if (MAVERICK_MCP_TOKEN) {
    const authz = req.headers.get("authorization");
    const expected = `Bearer ${MAVERICK_MCP_TOKEN}`;
    if (authz !== expected) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const format = url.searchParams.get("format") ?? "both";
  const skipCache = url.searchParams.get("cache") === "skip";

  try {
    const briefing = await buildBriefing({
      since: sinceParam ?? undefined,
      skipCache,
    });

    // Audit per session-open. Maverick is the first agent to call
    // audit() under its own attribution from this codebase — seeding
    // the new naming vocabulary into KV from day one.
    await audit({
      agent: "maverick",
      event: "load_state",
      status: briefing.narrative_synthesized ? "confirmed_success" : "uncertain",
      inputSummary: {
        since: briefing.structured.since,
        skip_cache: skipCache,
        format,
      },
      outputSummary: {
        duration_ms: briefing.duration_ms,
        narrative_synthesized: briefing.narrative_synthesized,
        narrative_error: briefing.narrative_error,
        source_health_summary: Object.fromEntries(
          Object.entries(briefing.source_health).map(([k, v]) => [
            k,
            { ok: v.ok, latency_ms: v.latency_ms, error: v.error },
          ]),
        ),
        staleness_warning_count: briefing.structured.staleness_warnings.length,
      },
      decision: skipCache ? "fresh_fetch" : "cache_eligible",
      ms: Date.now() - t0,
    });

    if (format === "narrative") {
      return new NextResponse(briefing.narrative, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (format === "structured") {
      return NextResponse.json({
        generated_at: briefing.generated_at,
        duration_ms: briefing.duration_ms,
        structured: briefing.structured,
        source_health: briefing.source_health,
      });
    }
    return NextResponse.json(briefing);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "maverick",
      event: "load_state_failed",
      status: "confirmed_failure",
      inputSummary: { since: sinceParam, skip_cache: skipCache, format },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { error: "maverick_load_state_failed", message: msg },
      { status: 500 },
    );
  }
}
