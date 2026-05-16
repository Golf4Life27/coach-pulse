// Maverick state aggregator endpoint — `/api/maverick/load-state`.
// @agent: maverick (Day 2; auth updated 5/16 Commit B.1)
//
// Single Vercel function that any Claude session can call at session
// open to load the entire operational state of the Inevitable
// system in <30s (P95 target per Spec v1.1 §8.1).
//
// Thin handler over lib/maverick/aggregator.buildBriefing. The
// aggregator owns cache, parallel fetch, cross-source synthesis,
// and Claude API synthesis with template fallback.
//
// Auth (Phase 20.3 — see Checklist Resolution Log):
//   1. Dashboard session cookie (`akb-auth=authenticated`,
//      sameSite=strict) — same-origin browser fetches from the
//      AuthGate-authenticated dashboard. Set by /api/auth on
//      successful password entry.
//   2. OAuth waterfall (Spec v1.2 §6.8) — OAuth opaque access token
//      OR CRON_SECRET + x-vercel-cron OR MAVERICK_MCP_TOKEN (dev-only).
//      Same module as /api/maverick/mcp.
//
// Query params:
//   - since=ISO         — override the 24h-ago default window
//   - format=narrative|structured|both (default: both)
//   - cache=skip        — bypass the 90s stale-while-revalidate cache
//
// Spec v1.1 §5 Step 1. Gate 2: P95 ≤ 30s on live data.

import { NextResponse } from "next/server";
import { buildBriefing } from "@/lib/maverick/aggregator";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby ceiling per AGENTS.md

export async function GET(req: Request) {
  const t0 = Date.now();

  // Auth resolution. Dashboard session checked first because it's the
  // fastest path (no KV lookup) + most common caller (Alex's browser).
  // External callers fall through to the OAuth waterfall, identical to
  // the MCP route's auth model.
  const cookieHeader = req.headers.get("cookie");
  const isDashboard = hasDashboardSession(cookieHeader);
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";

  if (isDashboard) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired =
      kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json(
          { error: "unauthorized", reason: auth.reason },
          { status: 401 },
        );
      }
      authKind = auth.kind;
    }
    // else: no auth configured anywhere (local dev / first deploy) — allow.
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
        auth_kind: authKind,
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
