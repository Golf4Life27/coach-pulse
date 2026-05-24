// Maverick OAuth — /register endpoint (RFC 7591 dynamic client registration).
// @agent: maverick (Day 4.5)
//
// Auto-approve in v1 — any well-formed registration request gets a
// client_id. Audited so leakage / abuse is detectable.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { saveClient, validateRegisterRequest } from "@/lib/maverick/oauth/clients";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(req: Request) {
  const t0 = Date.now();
  if (!kvConfigured()) {
    return errorResponse(503, "server_error", "OAuth storage unavailable");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_client_metadata", "request body must be JSON");
  }
  const v = validateRegisterRequest(body);
  if (!v.ok) {
    await audit({
      agent: "maverick",
      event: "oauth_register_rejected",
      status: "confirmed_failure",
      inputSummary: { error: v.error },
      outputSummary: { duration_ms: Date.now() - t0 },
    });
    return errorResponse(400, v.error, v.error_description);
  }
  await saveClient(kvProd, v.record);
  await audit({
    agent: "maverick",
    event: "oauth_register",
    status: "confirmed_success",
    inputSummary: {
      client_name: v.record.client_name,
      redirect_uris_count: v.record.redirect_uris.length,
      token_endpoint_auth_method: v.record.token_endpoint_auth_method,
    },
    outputSummary: {
      client_id_prefix: v.record.client_id.slice(0, 8),
      duration_ms: Date.now() - t0,
    },
  });
  // RFC 7591 §3.2.1 response shape.
  const body_out = {
    client_id: v.record.client_id,
    client_id_issued_at: Math.floor(new Date(v.record.created_at).getTime() / 1000),
    redirect_uris: v.record.redirect_uris,
    client_name: v.record.client_name,
    token_endpoint_auth_method: v.record.token_endpoint_auth_method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...(v.record.client_secret
      ? { client_secret: v.record.client_secret, client_secret_expires_at: 0 }
      : {}),
  };
  return new NextResponse(JSON.stringify(body_out), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, error: string, error_description: string) {
  return new NextResponse(JSON.stringify({ error, error_description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
