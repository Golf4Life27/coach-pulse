// Maverick OAuth — RFC 7591 dynamic client registration.
// @agent: maverick (Day 4.5)
//
// Single-user system, so auto-approve: any well-formed POST gets a
// client_id. PKCE replaces the security role of client_secret, but
// we issue one if the caller requests `token_endpoint_auth_method:
// "client_secret_post"` for compatibility with non-PKCE clients.

import { generateOpaqueToken } from "./crypto";
import type { KvClient } from "./kv";
import type { ClientRecord } from "./types";

const CLIENT_KEY = (clientId: string) => `maverick:oauth:client:${clientId}`;

export interface RegisterRequest {
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: "none" | "client_secret_post";
}

export type RegisterResult =
  | { ok: true; record: ClientRecord }
  | { ok: false; error: string; error_description: string };

/**
 * Validate the registration request shape per RFC 7591. Pure.
 *
 * Rejects:
 *  - missing/empty redirect_uris array
 *  - non-https redirect_uri (RFC 7591 §5; we relax to http only for localhost)
 *  - malformed redirect_uri
 *  - unknown token_endpoint_auth_method
 */
export function validateRegisterRequest(raw: unknown): RegisterResult {
  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      error_description: "request body must be a JSON object",
    };
  }
  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.redirect_uris) || r.redirect_uris.length === 0) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      error_description: "redirect_uris must be a non-empty array",
    };
  }
  for (const uri of r.redirect_uris) {
    if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        error_description: `redirect_uri ${JSON.stringify(uri)} is not a valid https URL (or http://localhost)`,
      };
    }
  }

  const auth = r.token_endpoint_auth_method;
  if (auth !== undefined && auth !== "none" && auth !== "client_secret_post") {
    return {
      ok: false,
      error: "invalid_client_metadata",
      error_description:
        "token_endpoint_auth_method must be 'none' or 'client_secret_post'",
    };
  }

  const now = new Date().toISOString();
  const clientId = generateOpaqueToken("mc_");
  const method =
    (auth as "none" | "client_secret_post" | undefined) ?? "none";
  const record: ClientRecord = {
    client_id: clientId,
    client_secret:
      method === "client_secret_post" ? generateOpaqueToken("cs_") : null,
    client_name:
      typeof r.client_name === "string" ? r.client_name.slice(0, 200) : "unknown",
    redirect_uris: r.redirect_uris as string[],
    token_endpoint_auth_method: method,
    created_at: now,
    last_used_at: now,
  };
  return { ok: true, record };
}

/** RFC 7591 §5 — redirect URI must be https (or http://localhost for dev). */
export function isValidRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    return host === "localhost" || host === "127.0.0.1";
  }
  return false;
}

export async function saveClient(
  kv: KvClient,
  record: ClientRecord,
): Promise<void> {
  await kv.set(CLIENT_KEY(record.client_id), JSON.stringify(record));
}

export async function loadClient(
  kv: KvClient,
  clientId: string,
): Promise<ClientRecord | null> {
  const raw = await kv.get(CLIENT_KEY(clientId));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ClientRecord;
  } catch {
    return null;
  }
}

/** Exact-match validation of a redirect_uri against the registered list. */
export function isRegisteredRedirectUri(
  client: ClientRecord,
  redirectUri: string,
): boolean {
  return client.redirect_uris.includes(redirectUri);
}
