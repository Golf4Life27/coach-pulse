// Maverick OAuth — access + refresh token operations.
// @agent: maverick (Day 4.5)
//
// Opaque tokens in Vercel KV. Access tokens are stateless to the
// MCP-route consumer (KV lookup → grant or deny). Refresh tokens
// rotate on each use; family_id binds rotated tokens for replay
// detection per OAuth 2.0 Security BCP (RFC 9700 §4.14).

import { generateFamilyId, generateOpaqueToken } from "./crypto";
import type { KvClient } from "./kv";
import type {
  AccessTokenRecord,
  FamilyRecord,
  RefreshTokenRecord,
} from "./types";

export const ACCESS_TTL_SECONDS = 3600; // 1 hour
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const ACCESS_KEY = (token: string) => `maverick:oauth:access:${token}`;
const REFRESH_KEY = (token: string) => `maverick:oauth:refresh:${token}`;
const FAMILY_KEY = (familyId: string) => `maverick:oauth:family:${familyId}`;

export interface IssueTokenPairArgs {
  client_id: string;
  subject: string;
  scope: string;
  /** When refreshing, reuse the prior family_id to chain rotation. New family on initial issue. */
  family_id?: string;
}

export interface TokenPair {
  access: AccessTokenRecord;
  refresh: RefreshTokenRecord;
}

/**
 * Issue a fresh access+refresh pair and persist both to KV with their
 * respective TTLs. Returns the records (also exposes the family marker
 * write so callers can rotate or invalidate as needed).
 */
export async function issueTokenPair(
  kv: KvClient,
  args: IssueTokenPairArgs,
  now: Date = new Date(),
): Promise<TokenPair> {
  const familyId = args.family_id ?? generateFamilyId();
  const accessToken = generateOpaqueToken("mat_");
  const refreshToken = generateOpaqueToken("mrt_");
  const nowMs = now.getTime();

  const access: AccessTokenRecord = {
    token: accessToken,
    client_id: args.client_id,
    subject: args.subject,
    scopes: [args.scope],
    issued_at: now.toISOString(),
    expires_at: new Date(nowMs + ACCESS_TTL_SECONDS * 1000).toISOString(),
  };
  const refresh: RefreshTokenRecord = {
    token: refreshToken,
    client_id: args.client_id,
    subject: args.subject,
    scope: args.scope,
    family_id: familyId,
    issued_at: now.toISOString(),
    expires_at: new Date(nowMs + REFRESH_TTL_SECONDS * 1000).toISOString(),
  };

  // Persist family marker on first issue. Subsequent rotations no-op on
  // overwriting the same record (idempotent).
  const family: FamilyRecord = {
    family_id: familyId,
    client_id: args.client_id,
    subject: args.subject,
    created_at: now.toISOString(),
    revoked: false,
    revoked_reason: null,
  };

  await Promise.all([
    kv.setEx(ACCESS_KEY(accessToken), JSON.stringify(access), ACCESS_TTL_SECONDS),
    kv.setEx(REFRESH_KEY(refreshToken), JSON.stringify(refresh), REFRESH_TTL_SECONDS),
    kv.setEx(FAMILY_KEY(familyId), JSON.stringify(family), REFRESH_TTL_SECONDS),
  ]);
  return { access, refresh };
}

export async function loadAccessToken(
  kv: KvClient,
  token: string,
): Promise<AccessTokenRecord | null> {
  const raw = await kv.get(ACCESS_KEY(token));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as AccessTokenRecord;
  } catch {
    return null;
  }
}

/** Single-use GETDEL semantics — the caller burns the refresh token on use. */
export async function consumeRefreshToken(
  kv: KvClient,
  token: string,
): Promise<RefreshTokenRecord | null> {
  const raw = await kv.getDel(REFRESH_KEY(token));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as RefreshTokenRecord;
  } catch {
    return null;
  }
}

export async function loadFamily(
  kv: KvClient,
  familyId: string,
): Promise<FamilyRecord | null> {
  const raw = await kv.get(FAMILY_KEY(familyId));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as FamilyRecord;
  } catch {
    return null;
  }
}

export async function revokeFamily(
  kv: KvClient,
  familyId: string,
  reason: string,
): Promise<void> {
  const family = await loadFamily(kv, familyId);
  if (!family) return;
  const updated: FamilyRecord = {
    ...family,
    revoked: true,
    revoked_reason: reason,
  };
  await kv.setEx(
    FAMILY_KEY(familyId),
    JSON.stringify(updated),
    REFRESH_TTL_SECONDS,
  );
}

export async function deleteAccessToken(
  kv: KvClient,
  token: string,
): Promise<number> {
  return kv.del(ACCESS_KEY(token));
}

export async function deleteRefreshToken(
  kv: KvClient,
  token: string,
): Promise<number> {
  return kv.del(REFRESH_KEY(token));
}

/** Token prefix used to disambiguate revoke-target type. */
export function tokenKind(token: string): "access" | "refresh" | "unknown" {
  if (token.startsWith("mat_")) return "access";
  if (token.startsWith("mrt_")) return "refresh";
  return "unknown";
}
