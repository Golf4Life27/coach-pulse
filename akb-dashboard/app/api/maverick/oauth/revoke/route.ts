// Maverick OAuth — /revoke endpoint (RFC 7009).
// @agent: maverick (Day 4.5)
//
// Body: application/x-www-form-urlencoded with `token` (required) +
// optional `token_type_hint` ("access_token" | "refresh_token"). Per
// RFC 7009 §2.2, the response is always 200 — revoking a non-existent
// or already-revoked token is a no-op, not an error. This prevents
// token-existence enumeration.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  deleteAccessToken,
  deleteRefreshToken,
  tokenKind,
} from "@/lib/maverick/oauth/tokens";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(req: Request) {
  const t0 = Date.now();
  if (!kvConfigured()) {
    return errorResponse(503, "server_error", "OAuth storage unavailable");
  }
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
  const token = form.get("token");
  if (!token) {
    return errorResponse(400, "invalid_request", "token parameter required");
  }
  const kind = tokenKind(token);
  let deleted = 0;
  if (kind === "access") {
    deleted = await deleteAccessToken(kvProd, token);
  } else if (kind === "refresh") {
    deleted = await deleteRefreshToken(kvProd, token);
  }
  // RFC 7009: always 200, even on unknown tokens.
  await audit({
    agent: "maverick",
    event: "oauth_token_revoked",
    status: "confirmed_success",
    inputSummary: {
      client_id: form.get("client_id"),
      token_type: kind,
      token_existed: deleted === 1,
    },
    outputSummary: { duration_ms: Date.now() - t0 },
  });
  return new NextResponse(null, { status: 200 });
}

function errorResponse(status: number, error: string, error_description: string) {
  return new NextResponse(JSON.stringify({ error, error_description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
