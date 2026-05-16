// Maverick MCP server — Streamable HTTP transport.
// @agent: maverick (Day 3)
//
// POST /api/maverick/mcp — JSON-RPC 2.0 endpoint that any Claude
// product (claude.ai web, Claude Code, future clients) can connect
// to via MCP server configuration.
//
// Auth: Bearer token in MAVERICK_MCP_TOKEN env var. Token-less mode
// is supported for local dev (omit the env var) but production
// deploys MUST set it; the registration in claude.ai project config
// includes the same token in the Authorization header.
//
// Per Inevitable Continuity Layer Spec v1.1 §5 Step 2.
// Gate 3: a fresh Claude session in the Inevitable project
// successfully calls maverick_load_state via MCP and receives the
// briefing.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { buildBriefing } from "@/lib/maverick/aggregator";
import { writeState } from "@/lib/maverick/write-state";
import { recall } from "@/lib/maverick/recall";
import { audit } from "@/lib/audit-log";
import {
  buildError,
  isNotification,
  validateJsonRpcRequest,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_INTERNAL_ERROR,
  MCP_UNAUTHORIZED,
  type JsonRpcResponse,
} from "@/lib/maverick/mcp/protocol";
import { dispatch } from "@/lib/maverick/mcp/handlers";
import {
  authenticate,
  buildWwwAuthenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
// Match the load-state endpoint's budget — when tools/call invokes
// load-state, both the load-state path and the MCP wrapper need
// headroom for the worst-case 30s briefing.
export const maxDuration = 60;

export async function POST(req: Request) {
  const t0 = Date.now();

  // Three-stage auth waterfall per Spec v1.2 §6.5:
  //   1. OAuth opaque access token (KV lookup) — claude.ai sessions
  //   2. CRON_SECRET + x-vercel-cron:1 — Vercel cron jobs (future Pulse)
  //   3. MAVERICK_MCP_TOKEN — ONLY when NODE_ENV !== "production" — dev/CI
  // Skipped entirely when OAuth KV isn't configured AND no dev/cron token
  // is set (local-dev convenience; matches the prior auth-optional path).
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const authRequired =
    kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
  if (authRequired) {
    const auth = await authenticate(headers, env, kvProd);
    if (!auth.ok) {
      const origin = resolveOrigin(req);
      // Audit the CRON_SECRET-without-header case so leakage is detectable.
      if (auth.reason === "cron_secret_match_without_x_vercel_cron") {
        await audit({
          agent: "maverick",
          event: "mcp_internal_auth_rejected",
          status: "confirmed_failure",
          inputSummary: { reason: auth.reason },
          outputSummary: { duration_ms: Date.now() - t0 },
        });
      }
      return new NextResponse(
        JSON.stringify(buildError(null, MCP_UNAUTHORIZED, auth.reason)),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": buildWwwAuthenticate(origin, auth.reason),
          },
        },
      );
    }
    if (auth.kind === "cron") {
      // First-touch audit on every internal-token call. Bounded by daily
      // cron cadence; anomalous volume = leaked CRON_SECRET being abused.
      await audit({
        agent: "maverick",
        event: "mcp_internal_auth",
        status: "confirmed_success",
        inputSummary: { x_vercel_id: req.headers.get("x-vercel-id") },
        outputSummary: { duration_ms: Date.now() - t0 },
      });
    }
  }

  // Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(buildError(null, JSON_RPC_PARSE_ERROR, "invalid JSON body"), 400);
  }

  // Validate JSON-RPC shape.
  const validated = validateJsonRpcRequest(body);
  if (!validated.ok) {
    return jsonResponse(validated.error, 400);
  }
  const { req: rpcReq } = validated;
  const id = rpcReq.id ?? null;

  // Dispatch.
  let result: JsonRpcResponse | null;
  try {
    result = await dispatch(rpcReq.method, rpcReq.params, id, {
      buildBriefing,
      writeState,
      recall,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "maverick",
      event: "mcp_dispatch_error",
      status: "confirmed_failure",
      inputSummary: { method: rpcReq.method },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
    });
    return jsonResponse(buildError(id, JSON_RPC_INTERNAL_ERROR, `dispatch error: ${msg}`), 500);
  }

  // Audit the call. For initialize/notifications/tools/list we log
  // confirmed_success; for tools/call we surface narrative_synthesized
  // state via the existing load-state audit (no double-logging here).
  if (rpcReq.method === "tools/call") {
    await audit({
      agent: "maverick",
      event: "mcp_tools_call",
      status: result && "error" in result ? "confirmed_failure" : "confirmed_success",
      inputSummary: {
        tool: getToolName(rpcReq.params),
        rpc_id: typeof id === "string" || typeof id === "number" ? id : null,
      },
      outputSummary: { duration_ms: Date.now() - t0 },
    });
  } else if (rpcReq.method === "initialize") {
    // First-touch audit — useful for tracking when new Claude
    // sessions handshake with Maverick.
    await audit({
      agent: "maverick",
      event: "mcp_initialize",
      status: "confirmed_success",
      inputSummary: {
        client_protocol_version: getProtocolVersion(rpcReq.params),
        client_info: getClientInfo(rpcReq.params),
      },
      outputSummary: { duration_ms: Date.now() - t0 },
    });
  }

  // Notifications: respond 202 with empty body per JSON-RPC 2.0.
  // result is null for notification cases; otherwise serialize.
  if (result === null) {
    if (!isNotification(rpcReq)) {
      // Defensive — non-notification dispatch returned null. This
      // shouldn't happen, but if it does, surface as 500.
      return jsonResponse(
        buildError(id, JSON_RPC_INTERNAL_ERROR, "handler returned null for non-notification"),
        500,
      );
    }
    return new NextResponse(null, { status: 202 });
  }

  return jsonResponse(result, 200);
}

/**
 * GET is reserved by the MCP Streamable HTTP transport for SSE
 * streaming of server-initiated messages. v1 doesn't push messages,
 * so we return 405 with the methods we DO support. This also makes
 * the endpoint diagnose-able from a browser: hitting the URL shows a
 * structured error instead of a generic 404.
 */
export function GET() {
  return new NextResponse(
    JSON.stringify({
      error: "method_not_allowed",
      message:
        "Maverick MCP server uses POST with JSON-RPC 2.0 body. GET/SSE streaming is reserved for future server-initiated messages and is not implemented in v1.",
      supported_methods: ["initialize", "tools/list", "tools/call", "ping", "notifications/initialized"],
      transport: "Streamable HTTP, request/response only (no SSE in v1)",
    }),
    {
      status: 405,
      headers: {
        "content-type": "application/json",
        allow: "POST",
      },
    },
  );
}

// ───────────────────── helpers ─────────────────────

function resolveOrigin(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

function jsonResponse(body: JsonRpcResponse, status: number): NextResponse {
  // MCP spec recommends including an Mcp-Session-Id header on
  // initialize responses for session continuity. v1 server is
  // stateless (briefing cache is process-wide, not per-session), so
  // we issue a session ID for protocol compatibility but don't
  // actually use it for routing. Clients can echo it on subsequent
  // requests — we accept it but don't require it.
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (status === 200 && "result" in body && isInitializeResult(body.result)) {
    headers["Mcp-Session-Id"] = randomUUID();
  }
  return new NextResponse(JSON.stringify(body), { status, headers });
}

function isInitializeResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "protocolVersion" in result &&
    "serverInfo" in result
  );
}

function getToolName(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function getProtocolVersion(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const v = (params as { protocolVersion?: unknown }).protocolVersion;
  return typeof v === "string" ? v : null;
}

function getClientInfo(params: unknown): Record<string, unknown> | null {
  if (typeof params !== "object" || params === null) return null;
  const ci = (params as { clientInfo?: unknown }).clientInfo;
  return typeof ci === "object" && ci !== null ? (ci as Record<string, unknown>) : null;
}
