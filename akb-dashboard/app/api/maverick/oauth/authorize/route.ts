// Maverick OAuth — /authorize endpoint.
// @agent: maverick (Day 4.5)
//
// Auto-approve in v1: validate params + lookup client + verify redirect_uri,
// then immediately issue code + 302-redirect back to the client. No HTML
// consent page rendered.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import {
  runAuthorize,
  validateAuthorizeRequest,
} from "@/lib/maverick/oauth/authorize";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function GET(req: Request) {
  const t0 = Date.now();
  if (!kvConfigured()) {
    return errorPage(503, "server_error", "OAuth storage unavailable");
  }
  const url = new URL(req.url);
  const validated = validateAuthorizeRequest(url.searchParams);
  if (!validated.ok) {
    await audit({
      agent: "maverick",
      event: "oauth_authorize_rejected",
      status: "confirmed_failure",
      inputSummary: {
        error: validated.error,
        client_id: url.searchParams.get("client_id"),
      },
      outputSummary: { duration_ms: Date.now() - t0 },
    });
    return errorPage(400, validated.error, validated.error_description);
  }

  const outcome = await runAuthorize(validated.req, kvProd);
  if (!outcome.ok) {
    await audit({
      agent: "maverick",
      event: "oauth_authorize_rejected",
      status: "confirmed_failure",
      inputSummary: { error: outcome.error, client_id: validated.req.client_id },
      outputSummary: { duration_ms: Date.now() - t0 },
    });
    // direct error → render plain error page (don't redirect to an
    // unverified redirect_uri).
    return errorPage(400, outcome.error, outcome.error_description);
  }
  await audit({
    agent: "maverick",
    event: "oauth_authorize_consent",
    status: "confirmed_success",
    inputSummary: { client_id: validated.req.client_id, scope: validated.req.scope },
    outputSummary: {
      code_prefix: outcome.code.slice(0, 8),
      duration_ms: Date.now() - t0,
    },
  });
  return NextResponse.redirect(outcome.redirect_to, 302);
}

function errorPage(status: number, error: string, error_description: string) {
  return new NextResponse(
    `<!doctype html><html><body><h1>OAuth error: ${error}</h1><p>${error_description}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
