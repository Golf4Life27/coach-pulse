// Maverick OAuth — RFC 9728 Protected Resource Metadata.
// @agent: maverick (Day 4.5)
//
// Tells MCP clients (claude.ai etc.) which authorization server issues
// tokens for the /api/maverick/mcp resource. Per RFC 9728 §3.1 this
// document lives at the origin root `.well-known` path — not under
// /api/maverick/. (Spec proposal §2 had this under /api/maverick/.well-known/;
// implementation amendment §15 documents the correction to origin-root.)
//
// Cache-friendly: claude.ai re-probes on every reconnect. 1h cache cuts
// repeated cold-starts.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET(req: Request) {
  const origin = resolveOrigin(req);
  const body = {
    resource: `${origin}/api/maverick/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["maverick:state"],
    bearer_methods_supported: ["header"],
    resource_documentation:
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
  // Prefer x-forwarded-proto/host on Vercel; fall back to host header.
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost";
  return `${proto}://${host}`;
}
