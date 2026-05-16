// Maverick OAuth — RFC 8414 Authorization Server Metadata.
// @agent: maverick (Day 4.5)
//
// Discovery document that names the endpoints + supported flows for
// this server. Maverick is both protected resource (mcp route) and
// authorization server (this metadata + the /oauth/* endpoints).
//
// Per RFC 8414 §3, document lives at the origin root .well-known path.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET(req: Request) {
  const origin = resolveOrigin(req);
  const body = {
    issuer: origin,
    authorization_endpoint: `${origin}/api/maverick/oauth/authorize`,
    token_endpoint: `${origin}/api/maverick/oauth/token`,
    registration_endpoint: `${origin}/api/maverick/oauth/register`,
    revocation_endpoint: `${origin}/api/maverick/oauth/revoke`,
    scopes_supported: ["maverick:state"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    service_documentation:
      "https://github.com/golf4life27/coach-pulse/blob/main/akb-dashboard/docs/specs/MAVERICK_OPS.md",
  };
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
    },
  });
}

function resolveOrigin(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost";
  return `${proto}://${host}`;
}
