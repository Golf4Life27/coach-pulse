// @agent: maverick — full OAuth dance end-to-end (Gate 3 protocol coverage).
//
// Simulates the claude.ai connector flow: dynamic registration →
// /authorize → /token (auth_code) → MCP call with access token →
// /token (refresh_token) → MCP call again. KV-stubbed.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { runAuthorize, validateAuthorizeRequest } from "./authorize";
import {
  isRegisteredRedirectUri,
  saveClient,
  validateRegisterRequest,
} from "./clients";
import { base64url } from "./crypto";
import { authenticate } from "./auth-waterfall";
import { makeMemoryKv } from "./kv";
import { parseTokenRequest, runTokenExchange } from "./token-exchange";

describe("OAuth full dance — Gate 3 simulation", () => {
  it("register → authorize → token → MCP-auth → refresh → MCP-auth again", async () => {
    const kv = makeMemoryKv();
    const REDIRECT = "https://claude.ai/api/oauth/callback";
    const verifier = "v".repeat(60);
    const challenge = base64url(createHash("sha256").update(verifier).digest());

    // ── Step 1: Dynamic client registration (RFC 7591) ──
    const reg = validateRegisterRequest({
      redirect_uris: [REDIRECT],
      client_name: "Claude",
    });
    if (!reg.ok) throw new Error("registration failed");
    await saveClient(kv, reg.record);
    expect(reg.record.client_id).toMatch(/^mc_/);
    expect(reg.record.client_secret).toBeNull(); // PKCE-only client

    // ── Step 2: /authorize (auto-approve in v1) ──
    const authzParams = new URLSearchParams({
      response_type: "code",
      client_id: reg.record.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "csrf123",
      scope: "maverick:state",
    });
    const authzValidated = validateAuthorizeRequest(authzParams);
    if (!authzValidated.ok) throw new Error("authorize validation failed");
    expect(isRegisteredRedirectUri(reg.record, REDIRECT)).toBe(true);
    const authzOutcome = await runAuthorize(authzValidated.req, kv);
    if (!authzOutcome.ok) throw new Error("authorize failed");
    expect(authzOutcome.code).toMatch(/^code_/);
    const redirectUrl = new URL(authzOutcome.redirect_to);
    expect(redirectUrl.searchParams.get("state")).toBe("csrf123");

    // ── Step 3: /token exchange (auth_code → access + refresh) ──
    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      code: authzOutcome.code,
      client_id: reg.record.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    const initialTokens = await runTokenExchange(parseTokenRequest(tokenForm), kv);
    if (!initialTokens.ok) {
      throw new Error(`token exchange failed: ${initialTokens.error}: ${initialTokens.error_description}`);
    }
    expect(initialTokens.access_token).toMatch(/^mat_/);
    expect(initialTokens.refresh_token).toMatch(/^mrt_/);

    // ── Step 4: MCP call with access token → waterfall grants ──
    const auth1 = await authenticate(
      { authorization: `Bearer ${initialTokens.access_token}`, x_vercel_cron: null },
      { cronSecret: null, bearerDevToken: null, isProduction: true },
      kv,
    );
    if (!auth1.ok) throw new Error(`mcp auth failed: ${auth1.reason}`);
    expect(auth1.kind).toBe("oauth");
    if (auth1.kind === "oauth") {
      expect(auth1.subject).toBe("alex");
      expect(auth1.client_id).toBe(reg.record.client_id);
      expect(auth1.scopes).toEqual(["maverick:state"]);
    }

    // ── Step 5: /token refresh (rotation + new pair) ──
    const refreshForm = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: initialTokens.refresh_token,
      client_id: reg.record.client_id,
    });
    const rotated = await runTokenExchange(parseTokenRequest(refreshForm), kv);
    if (!rotated.ok) {
      throw new Error(`refresh failed: ${rotated.error}: ${rotated.error_description}`);
    }
    expect(rotated.access_token).not.toBe(initialTokens.access_token);
    expect(rotated.refresh_token).not.toBe(initialTokens.refresh_token);

    // ── Step 6: MCP call with new access token → waterfall grants ──
    const auth2 = await authenticate(
      { authorization: `Bearer ${rotated.access_token}`, x_vercel_cron: null },
      { cronSecret: null, bearerDevToken: null, isProduction: true },
      kv,
    );
    if (!auth2.ok) throw new Error(`mcp auth (post-refresh) failed: ${auth2.reason}`);
    expect(auth2.kind).toBe("oauth");

    // ── Step 7: replayed refresh_token → invalid_grant ──
    const replay = await runTokenExchange(
      parseTokenRequest(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: initialTokens.refresh_token,
          client_id: reg.record.client_id,
        }),
      ),
      kv,
    );
    if (replay.ok) throw new Error("replay should fail");
    expect(replay.error).toBe("invalid_grant");
  });

  it("end-to-end with client_secret_post auth method", async () => {
    const kv = makeMemoryKv();
    const REDIRECT = "https://example.com/cb";
    const verifier = "v".repeat(60);
    const challenge = base64url(createHash("sha256").update(verifier).digest());

    const reg = validateRegisterRequest({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "client_secret_post",
    });
    if (!reg.ok) throw new Error("registration failed");
    await saveClient(kv, reg.record);
    expect(reg.record.client_secret).toMatch(/^cs_/);

    const authz = await runAuthorize(
      {
        response_type: "code",
        client_id: reg.record.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "maverick:state",
        state: "s",
      },
      kv,
    );
    if (!authz.ok) throw new Error("authorize failed");

    // Without client_secret → invalid_client
    const without = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code: authz.code,
        client_id: reg.record.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      kv,
    );
    if (without.ok) throw new Error("expected fail (missing client_secret)");
    expect(without.error).toBe("invalid_client");
  });
});
