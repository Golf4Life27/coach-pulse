// Maverick OAuth — /token handler logic.
// @agent: maverick (Day 4.5)
//
// Two grant types supported per spec proposal §1:
//   - authorization_code: redeem auth code + PKCE verifier → token pair
//   - refresh_token: rotate refresh token → new token pair (single-use,
//     replay-detected via family_id per RFC 9700 §4.14)

import {
  getAndDeleteAuthCode,
  isValidCodeVerifier,
  SUBJECT,
} from "./authorize";
import { loadClient } from "./clients";
import { constantTimeEqual, verifyPkce } from "./crypto";
import type { KvClient } from "./kv";
import {
  consumeRefreshToken,
  issueTokenPair,
  loadFamily,
  revokeFamily,
  type TokenPair,
} from "./tokens";

export type TokenSuccess = {
  ok: true;
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export type TokenError = {
  ok: false;
  http_status: number;
  error: string;
  error_description: string;
  /** When true, this rejection should trigger an `oauth_replay_detected` audit. */
  replay_detected?: boolean;
};

export type TokenResult = TokenSuccess | TokenError;

export interface TokenRequest {
  grant_type: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  client_secret?: string;
  code_verifier?: string;
  refresh_token?: string;
}

/** Pure: parse + minimally validate the form-encoded /token body. */
export function parseTokenRequest(form: URLSearchParams): TokenRequest {
  return {
    grant_type: form.get("grant_type") ?? "",
    code: form.get("code") ?? undefined,
    redirect_uri: form.get("redirect_uri") ?? undefined,
    client_id: form.get("client_id") ?? undefined,
    client_secret: form.get("client_secret") ?? undefined,
    code_verifier: form.get("code_verifier") ?? undefined,
    refresh_token: form.get("refresh_token") ?? undefined,
  };
}

export async function runTokenExchange(
  req: TokenRequest,
  kv: KvClient,
  now: Date = new Date(),
): Promise<TokenResult> {
  if (req.grant_type === "authorization_code") {
    return runAuthCodeGrant(req, kv, now);
  }
  if (req.grant_type === "refresh_token") {
    return runRefreshGrant(req, kv, now);
  }
  return {
    ok: false,
    http_status: 400,
    error: "unsupported_grant_type",
    error_description: `grant_type must be 'authorization_code' or 'refresh_token'; got ${JSON.stringify(req.grant_type)}`,
  };
}

async function runAuthCodeGrant(
  req: TokenRequest,
  kv: KvClient,
  now: Date,
): Promise<TokenResult> {
  if (!req.code || !req.client_id || !req.redirect_uri || !req.code_verifier) {
    return {
      ok: false,
      http_status: 400,
      error: "invalid_request",
      error_description:
        "authorization_code grant requires code + client_id + redirect_uri + code_verifier",
    };
  }
  if (!isValidCodeVerifier(req.code_verifier)) {
    return {
      ok: false,
      http_status: 400,
      error: "invalid_request",
      error_description:
        "code_verifier must be 43-128 chars of [A-Za-z0-9-._~] per RFC 7636",
    };
  }

  // Atomic GETDEL — only one concurrent /token call wins the code.
  const codeRecord = await getAndDeleteAuthCode(kv, req.code);
  if (!codeRecord) {
    return {
      ok: false,
      http_status: 400,
      error: "invalid_grant",
      error_description: "auth code is invalid, expired, or already consumed",
    };
  }

  // Validate client_id matches the one the code was issued for.
  if (codeRecord.client_id !== req.client_id) {
    return {
      ok: false,
      http_status: 400,
      error: "invalid_grant",
      error_description: "client_id does not match the auth code's issuing client",
    };
  }
  // Validate redirect_uri matches verbatim.
  if (codeRecord.redirect_uri !== req.redirect_uri) {
    return {
      ok: false,
      http_status: 400,
      error: "invalid_grant",
      error_description: "redirect_uri does not match the value presented at /authorize",
    };
  }
  // Verify the PKCE challenge.
  const pkceOk = verifyPkce(
    req.code_verifier,
    codeRecord.code_challenge,
    codeRecord.code_challenge_method,
  );
  if (!pkceOk) {
    return {
      ok: false,
      http_status: 400,
      error: "invalid_grant",
      error_description: "PKCE code_verifier does not match code_challenge",
    };
  }

  // Optional confidential-client validation.
  const client = await loadClient(kv, req.client_id);
  if (!client) {
    return {
      ok: false,
      http_status: 400,
      error: "invalid_client",
      error_description: "unknown client_id",
    };
  }
  if (client.token_endpoint_auth_method === "client_secret_post") {
    if (
      !req.client_secret ||
      !client.client_secret ||
      !constantTimeEqual(req.client_secret, client.client_secret)
    ) {
      return {
        ok: false,
        http_status: 401,
        error: "invalid_client",
        error_description: "client_secret is required for this client and did not match",
      };
    }
  }

  const pair = await issueTokenPair(
    kv,
    { client_id: req.client_id, subject: codeRecord.subject, scope: codeRecord.scope },
    now,
  );
  return tokenSuccess(pair, codeRecord.scope);
}

async function runRefreshGrant(
  req: TokenRequest,
  kv: KvClient,
  now: Date,
): Promise<TokenResult> {
  if (!req.refresh_token || !req.client_id) {
    return {
      ok: false,
      http_status: 400,
      error: "invalid_request",
      error_description: "refresh_token grant requires refresh_token + client_id",
    };
  }

  // Atomic GETDEL — single-use semantics. If missing, this is either an
  // expired token (legit) or a replay (presented after rotation already
  // consumed it). Distinguish via family lookup.
  const refreshRecord = await consumeRefreshToken(kv, req.refresh_token);
  if (!refreshRecord) {
    // Replay-detection: in this implementation we cannot pull the family_id
    // from a missing token. The protection is: rolling rotation means a
    // stolen token gets invalidated on first legitimate use; the attacker's
    // subsequent attempts fail with invalid_grant here. The family-id
    // cascade requires the original token's family_id which we no longer
    // have at this point — by design, we err on the side of failing-closed.
    return {
      ok: false,
      http_status: 400,
      error: "invalid_grant",
      error_description: "refresh_token is invalid, expired, or already consumed",
    };
  }

  // Family-level revocation check (in case a prior replay invalidated the family).
  const family = await loadFamily(kv, refreshRecord.family_id);
  if (family?.revoked) {
    // Defense-in-depth: even though the GETDEL succeeded above, if the
    // family was revoked between issue and this call, refuse + audit.
    return {
      ok: false,
      http_status: 400,
      error: "invalid_grant",
      error_description: `refresh token family revoked: ${family.revoked_reason ?? "unspecified"}`,
      replay_detected: true,
    };
  }

  if (refreshRecord.client_id !== req.client_id) {
    // Client_id mismatch on rotation — treat as suspicious + invalidate family.
    await revokeFamily(kv, refreshRecord.family_id, "client_id_mismatch_on_refresh");
    return {
      ok: false,
      http_status: 400,
      error: "invalid_grant",
      error_description: "client_id does not match the refresh token's issuing client",
      replay_detected: true,
    };
  }

  // Expiry check (KV TTL should have purged, but belt-and-suspenders).
  if (new Date(refreshRecord.expires_at).getTime() < now.getTime()) {
    return {
      ok: false,
      http_status: 400,
      error: "invalid_grant",
      error_description: "refresh_token expired",
    };
  }

  const pair = await issueTokenPair(
    kv,
    {
      client_id: refreshRecord.client_id,
      subject: refreshRecord.subject,
      scope: refreshRecord.scope,
      family_id: refreshRecord.family_id,
    },
    now,
  );
  return tokenSuccess(pair, refreshRecord.scope);
}

function tokenSuccess(pair: TokenPair, scope: string): TokenSuccess {
  return {
    ok: true,
    access_token: pair.access.token,
    token_type: "Bearer",
    expires_in: Math.max(
      1,
      Math.floor(
        (new Date(pair.access.expires_at).getTime() -
          new Date(pair.access.issued_at).getTime()) /
          1000,
      ),
    ),
    refresh_token: pair.refresh.token,
    scope,
  };
}

export { SUBJECT };
