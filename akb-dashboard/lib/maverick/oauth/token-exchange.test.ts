// @agent: maverick — OAuth /token grant tests.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { runAuthorize, validateAuthorizeRequest } from "./authorize";
import { saveClient, validateRegisterRequest } from "./clients";
import { base64url } from "./crypto";
import { makeMemoryKv, type KvClient } from "./kv";
import {
  parseTokenRequest,
  runTokenExchange,
} from "./token-exchange";

function pkceFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

async function setupClient(
  kv: KvClient,
  opts: { auth_method?: "none" | "client_secret_post"; redirect_uri?: string } = {},
) {
  const r = validateRegisterRequest({
    redirect_uris: [opts.redirect_uri ?? "https://claude.ai/api/oauth/callback"],
    client_name: "Claude",
    token_endpoint_auth_method: opts.auth_method ?? "none",
  });
  if (!r.ok) throw new Error("setup failed");
  await saveClient(kv, r.record);
  return r.record;
}

async function fullAuthorize(
  kv: KvClient,
  client: { client_id: string },
  verifier: string,
): Promise<{ code: string }> {
  const v = validateAuthorizeRequest(
    new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/api/oauth/callback",
      code_challenge: pkceFor(verifier),
      code_challenge_method: "S256",
      state: "csrf",
      scope: "maverick:state",
    }),
  );
  if (!v.ok) throw new Error("auth validation failed");
  const out = await runAuthorize(v.req, kv);
  if (!out.ok) throw new Error("authorize failed");
  return { code: out.code };
}

describe("parseTokenRequest", () => {
  it("parses form-urlencoded fields", () => {
    const r = parseTokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: "code_x",
        redirect_uri: "https://x/cb",
        client_id: "mc_x",
        code_verifier: "v".repeat(45),
      }),
    );
    expect(r.grant_type).toBe("authorization_code");
    expect(r.code).toBe("code_x");
    expect(r.code_verifier).toBe("v".repeat(45));
  });
});

describe("runTokenExchange — authorization_code grant", () => {
  it("happy path: code + verifier → access + refresh pair", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv);
    const verifier = "v".repeat(60);
    const { code } = await fullAuthorize(kv, client, verifier);
    const r = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/oauth/callback",
        code_verifier: verifier,
      },
      kv,
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.error}: ${r.error_description}`);
    expect(r.access_token).toMatch(/^mat_/);
    expect(r.refresh_token).toMatch(/^mrt_/);
    expect(r.token_type).toBe("Bearer");
    expect(r.expires_in).toBe(3600);
    expect(r.scope).toBe("maverick:state");
  });

  it("rejects unknown grant_type", async () => {
    const kv = makeMemoryKv();
    const r = await runTokenExchange(
      { grant_type: "password", code: "x", client_id: "mc_x" },
      kv,
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("unsupported_grant_type");
  });

  it("rejects missing required fields", async () => {
    const kv = makeMemoryKv();
    const r = await runTokenExchange({ grant_type: "authorization_code" }, kv);
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_request");
  });

  it("rejects malformed code_verifier (< 43 chars)", async () => {
    const kv = makeMemoryKv();
    const r = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code: "code_x",
        client_id: "mc_x",
        redirect_uri: "https://x/cb",
        code_verifier: "tooshort",
      },
      kv,
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_request");
  });

  it("rejects unknown / expired / replayed code with invalid_grant", async () => {
    const kv = makeMemoryKv();
    const r = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code: "code_nope",
        client_id: "mc_x",
        redirect_uri: "https://x/cb",
        code_verifier: "v".repeat(60),
      },
      kv,
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_grant");
  });

  it("rejects PKCE mismatch with invalid_grant", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv);
    const verifier = "v".repeat(60);
    const { code } = await fullAuthorize(kv, client, verifier);
    const r = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/oauth/callback",
        code_verifier: "w".repeat(60), // wrong verifier
      },
      kv,
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_grant");
  });

  it("rejects redirect_uri mismatch", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv);
    const verifier = "v".repeat(60);
    const { code } = await fullAuthorize(kv, client, verifier);
    const r = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://other.test/cb",
        code_verifier: verifier,
      },
      kv,
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_grant");
  });

  it("rejects client_id mismatch", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv);
    const verifier = "v".repeat(60);
    const { code } = await fullAuthorize(kv, client, verifier);
    const r = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code,
        client_id: "mc_other",
        redirect_uri: "https://claude.ai/api/oauth/callback",
        code_verifier: verifier,
      },
      kv,
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_grant");
  });

  it("requires client_secret when token_endpoint_auth_method=client_secret_post", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv, { auth_method: "client_secret_post" });
    const verifier = "v".repeat(60);
    const { code } = await fullAuthorize(kv, client, verifier);
    const r = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/oauth/callback",
        code_verifier: verifier,
      },
      kv,
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_client");
  });

  it("accepts matching client_secret when required", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv, { auth_method: "client_secret_post" });
    const verifier = "v".repeat(60);
    const { code } = await fullAuthorize(kv, client, verifier);
    const r = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/oauth/callback",
        code_verifier: verifier,
        client_secret: client.client_secret!,
      },
      kv,
    );
    expect(r.ok).toBe(true);
  });

  it("single-use semantics: second exchange of same code → invalid_grant", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv);
    const verifier = "v".repeat(60);
    const { code } = await fullAuthorize(kv, client, verifier);
    const first = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/oauth/callback",
        code_verifier: verifier,
      },
      kv,
    );
    expect(first.ok).toBe(true);
    const second = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/oauth/callback",
        code_verifier: verifier,
      },
      kv,
    );
    if (second.ok) throw new Error("expected fail");
    expect(second.error).toBe("invalid_grant");
  });
});

describe("runTokenExchange — refresh_token grant", () => {
  async function setupForRefresh() {
    const kv = makeMemoryKv();
    const client = await setupClient(kv);
    const verifier = "v".repeat(60);
    const { code } = await fullAuthorize(kv, client, verifier);
    const initial = await runTokenExchange(
      {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/oauth/callback",
        code_verifier: verifier,
      },
      kv,
    );
    if (!initial.ok) throw new Error("setup failed");
    return { kv, client, initial };
  }

  it("rotates refresh token + issues new access token", async () => {
    const { kv, client, initial } = await setupForRefresh();
    const rotated = await runTokenExchange(
      {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: client.client_id,
      },
      kv,
    );
    if (!rotated.ok) throw new Error(`expected ok: ${JSON.stringify(rotated)}`);
    expect(rotated.access_token).not.toBe(initial.access_token);
    expect(rotated.refresh_token).not.toBe(initial.refresh_token);
  });

  it("invalidates the old refresh token on rotation (replay protection)", async () => {
    const { kv, client, initial } = await setupForRefresh();
    await runTokenExchange(
      {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: client.client_id,
      },
      kv,
    );
    const replay = await runTokenExchange(
      {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: client.client_id,
      },
      kv,
    );
    if (replay.ok) throw new Error("expected fail");
    expect(replay.error).toBe("invalid_grant");
  });

  it("revokes the family when client_id doesn't match", async () => {
    const { kv, client, initial } = await setupForRefresh();
    const wrongClient = await runTokenExchange(
      {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: "mc_attacker",
      },
      kv,
    );
    if (wrongClient.ok) throw new Error("expected fail");
    expect(wrongClient.error).toBe("invalid_grant");
    expect(wrongClient.replay_detected).toBe(true);
    void client;
  });

  it("rejects with invalid_grant when token unknown", async () => {
    const kv = makeMemoryKv();
    const r = await runTokenExchange(
      { grant_type: "refresh_token", refresh_token: "mrt_nope", client_id: "mc_x" },
      kv,
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_grant");
  });
});
