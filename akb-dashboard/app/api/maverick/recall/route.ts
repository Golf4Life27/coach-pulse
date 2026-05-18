// Maverick recall HTTP endpoint — `/api/maverick/recall`.
// @agent: maverick (Phase 9.8)
//
// Thin HTTP surface over `lib/maverick/recall.ts` for dashboard-driven
// recall calls (Daily UX Spec §7.1 related-deal panel). User-triggered,
// not polling — invoked when Alex opens a deal-detail page and the
// related-deals panel mounts.
//
// Auth: same model as /api/maverick/load-state.
//   1. Dashboard session cookie (akb-auth=authenticated) — same-origin
//      fetches from the AuthGate-authenticated dashboard. Most common.
//   2. OAuth waterfall — external Claude clients can hit this too, but
//      they should generally use the MCP tools/call path; this endpoint
//      is primarily for the in-dashboard related-deals UI.
//
// Body (POST, JSON):
//   { query: string, since?: ISO, until?: ISO, sources?: RecallSource[] }
//
// Returns: RecallResponse from lib/maverick/recall.

import { NextResponse } from "next/server";
import { recall, validateRecallArgs } from "@/lib/maverick/recall";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const t0 = Date.now();

  // Auth — dashboard session first, OAuth waterfall fallback.
  const cookieHeader = req.headers.get("cookie");
  const isDashboard = hasDashboardSession(cookieHeader);
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" =
    "none";

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
  }

  // Phase 11.6 cron-burn safeguard mirrors load-state — recall is
  // user-triggered by design, cron calls are gated off by default.
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    await audit({
      agent: "maverick",
      event: "recall_cron_gated",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind },
      outputSummary: { reason: "MAVERICK_CRON_ENABLED!=true" },
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      {
        error: "cron_disabled",
        reason: "MAVERICK_CRON_ENABLED must be 'true' to invoke recall from cron",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json_body" },
      { status: 400 },
    );
  }

  const validated = validateRecallArgs(body);
  if (!validated.ok) {
    return NextResponse.json(
      { error: "invalid_args", reason: validated.error },
      { status: 400 },
    );
  }

  try {
    const response = await recall(validated.args);
    await audit({
      agent: "maverick",
      event: "recall",
      status: "confirmed_success",
      inputSummary: {
        query: validated.args.query.slice(0, 80),
        sources: validated.args.sources ?? ["spine", "audit"],
        auth_kind: authKind,
      },
      outputSummary: {
        result_count: response.results.length,
        truncated_to_n: response.truncated_to_n,
        duration_ms: Date.now() - t0,
      },
    });
    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "maverick",
      event: "recall_failed",
      status: "confirmed_failure",
      inputSummary: { query: validated.args.query.slice(0, 80) },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { error: "recall_failed", message: msg },
      { status: 500 },
    );
  }
}
