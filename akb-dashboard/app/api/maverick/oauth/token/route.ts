// Maverick OAuth — /token endpoint.
// @agent: maverick (Day 4.5)
//
// Handles two grant types per spec proposal §1:
//   - authorization_code → exchange code+PKCE for access+refresh pair
//   - refresh_token      → rotate to a new pair (rolling rotation,
//                          family-id replay detection)
//
// Body is application/x-www-form-urlencoded per RFC 6749 §3.2.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  parseTokenRequest,
  runTokenExchange,
} from "@/lib/maverick/oauth/token-exchange";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(req: Request) {
  const t0 = Date.now();
  if (!kvConfigured()) {
    return errorResponse(503, "server_error", "OAuth storage unavailable");
  }
  // RFC 6749 mandates application/x-www-form-urlencoded on /token.
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded")) {
    return errorResponse(
      400,
      "invalid_request",
      "content-type must be application/x-www-form-urlencoded",
    );
  }
  const text = await req.text();
  const form = new URLSearchParams(text);
  const reqShape = parseTokenRequest(form);

  const result = await runTokenExchange(reqShape, kvProd);

  if (!result.ok) {
    if (result.replay_detected) {
      await audit({
        agent: "maverick",
        event: "oauth_replay_detected",
        status: "confirmed_failure",
        inputSummary: {
          client_id: reqShape.client_id,
          grant_type: reqShape.grant_type,
        },
        outputSummary: { duration_ms: Date.now() - t0 },
      });
    } else {
      await audit({
        agent: "maverick",
        event: "oauth_token_rejected",
        status: "confirmed_failure",
        inputSummary: {
          grant_type: reqShape.grant_type,
          client_id: reqShape.client_id,
          error: result.error,
        },
        outputSummary: { duration_ms: Date.now() - t0 },
      });
    }
    return errorResponse(result.http_status, result.error, result.error_description);
  }

  await audit({
    agent: "maverick",
    event:
      reqShape.grant_type === "refresh_token"
        ? "oauth_token_refreshed"
        : "oauth_token_issued",
    status: "confirmed_success",
    inputSummary: { client_id: reqShape.client_id, grant_type: reqShape.grant_type },
    outputSummary: {
      access_token_prefix: result.access_token.slice(0, 8),
      duration_ms: Date.now() - t0,
    },
  });
  return new NextResponse(
    JSON.stringify({
      access_token: result.access_token,
      token_type: result.token_type,
      expires_in: result.expires_in,
      refresh_token: result.refresh_token,
      scope: result.scope,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Prevent caching of tokens by intermediaries.
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    },
  );
}

function errorResponse(status: number, error: string, error_description: string) {
  return new NextResponse(JSON.stringify({ error, error_description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
