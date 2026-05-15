// Maverick OAuth — type definitions.
// @agent: maverick (Day 4.5)
//
// Source of truth for the KV record shapes + auth-result discriminated
// union. Keep this file dependency-free so route handlers + tests can
// import types without pulling crypto / KV side effects.

export type Pkce =
  | { method: "S256"; code_challenge: string }
  | { method: "plain"; code_challenge: string };

/** Registered OAuth client. KV key: `maverick:oauth:client:<client_id>` (no TTL). */
export interface ClientRecord {
  client_id: string;
  client_secret: string | null; // null when token_endpoint_auth_method = "none" (PKCE only)
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none" | "client_secret_post";
  created_at: string;
  last_used_at: string;
}

/** Auth code, 60s TTL, single-use via GETDEL. KV key: `maverick:oauth:code:<code>`. */
export interface AuthCodeRecord {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256" | "plain";
  scope: string;
  state: string | null;
  subject: string;
  issued_at: string;
}

/** Opaque access token, 1h TTL. KV key: `maverick:oauth:access:<token>`. */
export interface AccessTokenRecord {
  token: string;
  client_id: string;
  subject: string;
  scopes: string[];
  issued_at: string;
  expires_at: string;
}

/**
 * Opaque refresh token, 30d TTL with rolling rotation. Single-use via GETDEL
 * on each /token refresh_token call. family_id binds rotated tokens together
 * for replay detection. KV key: `maverick:oauth:refresh:<token>`.
 */
export interface RefreshTokenRecord {
  token: string;
  client_id: string;
  subject: string;
  scope: string;
  family_id: string;
  issued_at: string;
  expires_at: string;
}

/**
 * Family marker — used to detect refresh-token replay. When a refresh token
 * is presented but already GETDEL'd, we check if its family_id is still
 * valid; if yes → someone replayed an old token → invalidate the family +
 * audit oauth_replay_detected. KV key: `maverick:oauth:family:<family_id>`.
 * TTL tracks the longest refresh token in the family.
 */
export interface FamilyRecord {
  family_id: string;
  client_id: string;
  subject: string;
  created_at: string;
  revoked: boolean;
  revoked_reason: string | null;
}

// ───────────────────── auth waterfall ─────────────────────

/** Result of the three-stage auth check at /api/maverick/mcp. */
export type AuthResult =
  | {
      ok: true;
      kind: "oauth";
      subject: string;
      client_id: string;
      scopes: string[];
    }
  | { ok: true; kind: "cron" }
  | { ok: true; kind: "bearer_dev" }
  | {
      ok: false;
      reason:
        | "no_authorization_header"
        | "malformed_authorization_header"
        | "oauth_token_unknown"
        | "oauth_token_expired"
        | "cron_secret_match_without_x_vercel_cron"
        | "bearer_dev_blocked_in_production"
        | "no_credential_matched";
    };
