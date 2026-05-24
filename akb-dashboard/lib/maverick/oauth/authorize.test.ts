// @agent: maverick — OAuth /authorize handler tests.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  getAndDeleteAuthCode,
  runAuthorize,
  validateAuthorizeRequest,
} from "./authorize";
import { saveClient, validateRegisterRequest } from "./clients";
import { base64url } from "./crypto";
import { makeMemoryKv, type KvClient } from "./kv";

function pkceFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

async function setupClient(
  kv: KvClient,
  redirectUris = ["https://claude.ai/api/oauth/callback"],
) {
  const r = validateRegisterRequest({
    redirect_uris: redirectUris,
    client_name: "Claude",
  });
  if (!r.ok) throw new Error("setup failed");
  await saveClient(kv, r.record);
  return r.record;
}

function authorizeParams(over: Partial<Record<string, string>> = {}): URLSearchParams {
  const verifier = "x".repeat(60);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: over.client_id ?? "mc_test",
    redirect_uri: over.redirect_uri ?? "https://claude.ai/api/oauth/callback",
    code_challenge: over.code_challenge ?? pkceFor(verifier),
    code_challenge_method: over.code_challenge_method ?? "S256",
    state: over.state ?? "csrf123",
    scope: over.scope ?? "maverick:state",
    ...over,
  });
  return params;
}

describe("validateAuthorizeRequest — happy path", () => {
  it("accepts a fully-formed request", () => {
    const v = validateAuthorizeRequest(authorizeParams());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.req.response_type).toBe("code");
      expect(v.req.code_challenge_method).toBe("S256");
      expect(v.req.scope).toBe("maverick:state");
    }
  });

  it("defaults scope to maverick:state when omitted", () => {
    const p = authorizeParams();
    p.delete("scope");
    const v = validateAuthorizeRequest(p);
    if (!v.ok) throw new Error("expected ok");
    expect(v.req.scope).toBe("maverick:state");
  });
});

describe("validateAuthorizeRequest — rejections", () => {
  it("rejects response_type != code", () => {
    const v = validateAuthorizeRequest(authorizeParams({ response_type: "token" }));
    if (v.ok) throw new Error("expected fail");
    expect(v.error).toBe("unsupported_response_type");
  });
  it("rejects missing client_id / redirect_uri / code_challenge / state", () => {
    for (const k of ["client_id", "redirect_uri", "code_challenge", "state"]) {
      const p = authorizeParams();
      p.delete(k);
      const v = validateAuthorizeRequest(p);
      expect(v.ok).toBe(false);
    }
  });
  it("rejects code_challenge_method != S256 (plain unsupported)", () => {
    const v = validateAuthorizeRequest(
      authorizeParams({ code_challenge_method: "plain" }),
    );
    expect(v.ok).toBe(false);
  });
  it("rejects malformed code_challenge (wrong length)", () => {
    const v = validateAuthorizeRequest(authorizeParams({ code_challenge: "tooshort" }));
    expect(v.ok).toBe(false);
  });
  it("rejects unsupported scope", () => {
    const v = validateAuthorizeRequest(authorizeParams({ scope: "admin:everything" }));
    if (v.ok) throw new Error("expected fail");
    expect(v.error).toBe("invalid_scope");
  });
});

describe("runAuthorize — auto-approve", () => {
  it("issues a code + redirects with ?code=...&state=... on success", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv);
    const v = validateAuthorizeRequest(authorizeParams({ client_id: client.client_id }));
    if (!v.ok) throw new Error("setup failed");
    const out = await runAuthorize(v.req, kv);
    if (!out.ok) throw new Error("expected ok");
    expect(out.code).toMatch(/^code_/);
    const url = new URL(out.redirect_to);
    expect(url.origin + url.pathname).toBe("https://claude.ai/api/oauth/callback");
    expect(url.searchParams.get("code")).toBe(out.code);
    expect(url.searchParams.get("state")).toBe("csrf123");
  });

  it("persists the auth code to KV with the request's PKCE challenge + scope", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv);
    const v = validateAuthorizeRequest(authorizeParams({ client_id: client.client_id }));
    if (!v.ok) throw new Error("setup failed");
    const out = await runAuthorize(v.req, kv);
    if (!out.ok) throw new Error("expected ok");
    // We use getAndDelete because there's no separate "peek" path; that's fine
    // for the test — burn the code to inspect contents.
    const stored = await getAndDeleteAuthCode(kv, out.code);
    expect(stored).not.toBeNull();
    expect(stored!.client_id).toBe(client.client_id);
    expect(stored!.code_challenge).toBe(v.req.code_challenge);
    expect(stored!.scope).toBe("maverick:state");
    expect(stored!.state).toBe("csrf123");
  });

  it("rejects unknown client_id with direct error (no redirect)", async () => {
    const kv = makeMemoryKv();
    const v = validateAuthorizeRequest(authorizeParams({ client_id: "mc_unknown" }));
    if (!v.ok) throw new Error("setup failed");
    const out = await runAuthorize(v.req, kv);
    if (out.ok) throw new Error("expected fail");
    expect(out.error).toBe("unauthorized_client");
    expect(out.via).toBe("direct");
  });

  it("rejects redirect_uri not in the registered list (direct error)", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv, ["https://claude.ai/api/oauth/callback"]);
    const v = validateAuthorizeRequest(
      authorizeParams({
        client_id: client.client_id,
        redirect_uri: "https://attacker.example/cb",
      }),
    );
    if (!v.ok) throw new Error("setup failed");
    const out = await runAuthorize(v.req, kv);
    if (out.ok) throw new Error("expected fail");
    expect(out.error).toBe("invalid_request");
  });
});

describe("getAndDeleteAuthCode — single-use semantics", () => {
  it("returns null on the second call (atomic GETDEL)", async () => {
    const kv = makeMemoryKv();
    const client = await setupClient(kv);
    const v = validateAuthorizeRequest(authorizeParams({ client_id: client.client_id }));
    if (!v.ok) throw new Error("setup failed");
    const out = await runAuthorize(v.req, kv);
    if (!out.ok) throw new Error("expected ok");
    const first = await getAndDeleteAuthCode(kv, out.code);
    expect(first).not.toBeNull();
    const second = await getAndDeleteAuthCode(kv, out.code);
    expect(second).toBeNull();
  });
});
