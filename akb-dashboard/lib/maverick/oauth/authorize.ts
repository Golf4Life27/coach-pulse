// Maverick OAuth — /authorize handler logic.
// @agent: maverick (Day 4.5)
//
// Auto-approve in v1 (single-user, single-scope, no consent UI).
// Pure validation + auth-code generation. KV write + redirect-URL
// composition live in the route handler.

import { generateOpaqueToken, isValidCodeVerifier } from "./crypto";
import {
  isRegisteredRedirectUri,
  loadClient,
} from "./clients";
import type { KvClient } from "./kv";
import type { AuthCodeRecord, ClientRecord } from "./types";

const CODE_KEY = (code: string) => `maverick:oauth:code:${code}`;
const CODE_TTL_SECONDS = 60;

export const SUBJECT = "alex"; // single-user system

export interface AuthorizeRequest {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  state?: string;
}

export type AuthorizeOutcome =
  | {
      ok: true;
      redirect_to: string; // ${redirect_uri}?code=...&state=...
      code: string;
    }
  | {
      ok: false;
      // Per RFC 6749 §4.1.2.1, errors that occur AFTER redirect_uri validation
      // redirect back to the client with ?error=... in the query.
      // Errors BEFORE redirect_uri validation (unknown client, invalid
      // redirect_uri) return a plain error response (no redirect).
      via: "redirect" | "direct";
      error: string;
      error_description: string;
      redirect_uri?: string;
      state?: string;
    };

/**
 * Pre-flight validation of authorize-request shape. Pure, no I/O.
 * Returns the typed request or a direct error.
 */
export function validateAuthorizeRequest(
  params: URLSearchParams,
):
  | { ok: true; req: AuthorizeRequest }
  | { ok: false; error: string; error_description: string } {
  const response_type = params.get("response_type");
  const client_id = params.get("client_id");
  const redirect_uri = params.get("redirect_uri");
  const code_challenge = params.get("code_challenge");
  const code_challenge_method = params.get("code_challenge_method") ?? "S256";
  const scope = params.get("scope") ?? "maverick:state";
  const state = params.get("state");

  if (response_type !== "code") {
    return {
      ok: false,
      error: "unsupported_response_type",
      error_description: "response_type must be 'code'",
    };
  }
  if (!client_id) {
    return {
      ok: false,
      error: "invalid_request",
      error_description: "client_id is required",
    };
  }
  if (!redirect_uri) {
    return {
      ok: false,
      error: "invalid_request",
      error_description: "redirect_uri is required",
    };
  }
  if (!code_challenge) {
    return {
      ok: false,
      error: "invalid_request",
      error_description: "code_challenge is required (PKCE)",
    };
  }
  if (code_challenge_method !== "S256") {
    return {
      ok: false,
      error: "invalid_request",
      error_description: "code_challenge_method must be 'S256' (plain not supported)",
    };
  }
  // RFC 7636 §4.2 — code_challenge: base64url-encoded SHA-256, 43 chars
  if (!/^[A-Za-z0-9\-._~]{43}$/.test(code_challenge)) {
    return {
      ok: false,
      error: "invalid_request",
      error_description: "code_challenge must be 43-char base64url",
    };
  }
  if (!state) {
    return {
      ok: false,
      error: "invalid_request",
      error_description: "state is required (CSRF protection)",
    };
  }
  if (scope !== "maverick:state") {
    return {
      ok: false,
      error: "invalid_scope",
      error_description: "only 'maverick:state' is supported in v1.2",
    };
  }
  return {
    ok: true,
    req: {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      state,
    },
  };
}

/**
 * Run the full /authorize handler logic. Loads client from KV, validates
 * redirect_uri, generates auth code, persists. Returns either a 302-target
 * URL (auto-approve in v1) or an error outcome.
 */
export async function runAuthorize(
  req: AuthorizeRequest,
  kv: KvClient,
  now: Date = new Date(),
): Promise<AuthorizeOutcome> {
  const client = await loadClient(kv, req.client_id);
  if (!client) {
    return {
      ok: false,
      via: "direct",
      error: "unauthorized_client",
      error_description: "unknown client_id",
    };
  }
  if (!isRegisteredRedirectUri(client, req.redirect_uri)) {
    return {
      ok: false,
      via: "direct",
      error: "invalid_request",
      error_description:
        "redirect_uri does not match any registered redirect_uri for this client (exact match required)",
    };
  }

  // Auto-approve. Issue code, redirect.
  const code = generateOpaqueToken("code_");
  const record: AuthCodeRecord = {
    code,
    client_id: req.client_id,
    redirect_uri: req.redirect_uri,
    code_challenge: req.code_challenge,
    code_challenge_method: req.code_challenge_method as "S256" | "plain",
    scope: req.scope ?? "maverick:state",
    state: req.state ?? null,
    subject: SUBJECT,
    issued_at: now.toISOString(),
  };
  await kv.setEx(CODE_KEY(code), JSON.stringify(record), CODE_TTL_SECONDS);

  const url = new URL(req.redirect_uri);
  url.searchParams.set("code", code);
  if (req.state) url.searchParams.set("state", req.state);
  return { ok: true, redirect_to: url.toString(), code };
}

/** Internal: re-export for /token consumption. */
export async function getAndDeleteAuthCode(
  kv: KvClient,
  code: string,
): Promise<AuthCodeRecord | null> {
  const raw = await kv.getDel(CODE_KEY(code));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as AuthCodeRecord;
  } catch {
    return null;
  }
}

export { isValidCodeVerifier };
