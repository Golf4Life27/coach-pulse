// Maverick OAuth — three-stage auth resolver for /api/maverick/mcp.
// @agent: maverick (Day 4.5)
//
// 1. OAuth opaque access token (KV lookup) — claude.ai sessions
// 2. CRON_SECRET constant-time compare + x-vercel-cron:1 header — Vercel crons
// 3. MAVERICK_MCP_TOKEN — ONLY when NODE_ENV !== "production" — dev/CI smoke
//
// Returns a discriminated-union AuthResult; route handlers decide audit
// + 401/403 response shape.

import { constantTimeEqual } from "./crypto";
import type { KvClient } from "./kv";
import { loadAccessToken } from "./tokens";
import type { AuthResult } from "./types";

export interface AuthEnv {
  cronSecret: string | null;
  bearerDevToken: string | null;
  isProduction: boolean;
}

export function readAuthEnv(): AuthEnv {
  return {
    cronSecret: process.env.CRON_SECRET ?? null,
    bearerDevToken: process.env.MAVERICK_MCP_TOKEN ?? null,
    isProduction: process.env.NODE_ENV === "production",
  };
}

export interface AuthHeaders {
  authorization: string | null;
  x_vercel_cron: string | null;
}

export function readAuthHeaders(req: Request): AuthHeaders {
  return {
    authorization: req.headers.get("authorization"),
    x_vercel_cron: req.headers.get("x-vercel-cron"),
  };
}

/**
 * Run the auth waterfall. Pure given the KV client + env + headers; no
 * env-var reads inside (callers pass an AuthEnv so tests can vary it).
 *
 * Tries each credential class in order and short-circuits on the first
 * successful match. On no-match, returns `ok: false` with a typed reason.
 */
export async function authenticate(
  headers: AuthHeaders,
  env: AuthEnv,
  kv: KvClient,
  now: Date = new Date(),
): Promise<AuthResult> {
  if (!headers.authorization) {
    return { ok: false, reason: "no_authorization_header" };
  }
  if (!headers.authorization.startsWith("Bearer ")) {
    return { ok: false, reason: "malformed_authorization_header" };
  }
  const token = headers.authorization.slice("Bearer ".length).trim();
  if (!token) {
    return { ok: false, reason: "malformed_authorization_header" };
  }

  // Stage 1 — OAuth opaque access token. Match by prefix; only attempt KV
  // lookup when the prefix matches so non-OAuth tokens skip the KV round-trip.
  if (token.startsWith("mat_")) {
    const access = await loadAccessToken(kv, token);
    if (!access) {
      return { ok: false, reason: "oauth_token_unknown" };
    }
    if (new Date(access.expires_at).getTime() <= now.getTime()) {
      return { ok: false, reason: "oauth_token_expired" };
    }
    return {
      ok: true,
      kind: "oauth",
      subject: access.subject,
      client_id: access.client_id,
      scopes: access.scopes,
    };
  }

  // Stage 2 — CRON_SECRET. Defense-in-depth: also require x-vercel-cron:1.
  if (env.cronSecret && constantTimeEqual(token, env.cronSecret)) {
    if (headers.x_vercel_cron === "1") {
      return { ok: true, kind: "cron" };
    }
    return { ok: false, reason: "cron_secret_match_without_x_vercel_cron" };
  }

  // Stage 3 — bearer dev fallback. Production refuses this path even
  // when MAVERICK_MCP_TOKEN happens to match (defense against env-var
  // leaks in prod bypassing OAuth).
  if (env.bearerDevToken && constantTimeEqual(token, env.bearerDevToken)) {
    if (env.isProduction) {
      return { ok: false, reason: "bearer_dev_blocked_in_production" };
    }
    return { ok: true, kind: "bearer_dev" };
  }

  return { ok: false, reason: "no_credential_matched" };
}

export type AuthFailureReason = Extract<AuthResult, { ok: false }>["reason"];

/**
 * Build the WWW-Authenticate header per RFC 6750 §3 for a 401 response.
 * Points clients at the protected-resource metadata for OAuth discovery
 * (MCP spec convention: clients fetch this on 401 to find the auth server).
 */
export function buildWwwAuthenticate(
  origin: string,
  reason: AuthFailureReason,
): string {
  const errorCode =
    reason === "oauth_token_expired" || reason === "oauth_token_unknown"
      ? "invalid_token"
      : "invalid_request";
  const description = reasonToDescription(reason);
  return (
    `Bearer realm="maverick", ` +
    `error="${errorCode}", ` +
    `error_description="${description}", ` +
    `resource_metadata="${origin}/.well-known/oauth-protected-resource"`
  );
}

function reasonToDescription(reason: AuthFailureReason): string {
  switch (reason) {
    case "no_authorization_header":
      return "Authorization header required";
    case "malformed_authorization_header":
      return "Authorization header must be 'Bearer <token>'";
    case "oauth_token_unknown":
      return "Unknown or revoked access token";
    case "oauth_token_expired":
      return "Access token expired; refresh via /api/maverick/oauth/token";
    case "cron_secret_match_without_x_vercel_cron":
      return "CRON_SECRET match requires x-vercel-cron header";
    case "bearer_dev_blocked_in_production":
      return "Bearer dev token blocked in production environment";
    case "no_credential_matched":
      return "No matching credential — register via /api/maverick/oauth/register";
  }
}
