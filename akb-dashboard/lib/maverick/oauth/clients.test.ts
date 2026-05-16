// @agent: maverick — OAuth dynamic client registration tests.

import { describe, it, expect } from "vitest";
import {
  isRegisteredRedirectUri,
  isValidRedirectUri,
  loadClient,
  saveClient,
  validateRegisterRequest,
} from "./clients";
import { makeMemoryKv } from "./kv";

describe("validateRegisterRequest — happy paths", () => {
  it("accepts a minimal valid request (PKCE-only, no client_secret)", () => {
    const r = validateRegisterRequest({
      redirect_uris: ["https://claude.ai/api/oauth/callback"],
      client_name: "Claude",
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.record.client_id).toMatch(/^mc_/);
    expect(r.record.client_secret).toBeNull();
    expect(r.record.token_endpoint_auth_method).toBe("none");
    expect(r.record.redirect_uris).toEqual(["https://claude.ai/api/oauth/callback"]);
    expect(r.record.client_name).toBe("Claude");
  });

  it("issues a client_secret when token_endpoint_auth_method=client_secret_post", () => {
    const r = validateRegisterRequest({
      redirect_uris: ["https://example.com/cb"],
      token_endpoint_auth_method: "client_secret_post",
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.record.client_secret).toMatch(/^cs_/);
  });

  it("permits http://localhost redirect URIs for dev", () => {
    const r = validateRegisterRequest({
      redirect_uris: ["http://localhost:3000/callback", "http://127.0.0.1:8080/cb"],
    });
    expect(r.ok).toBe(true);
  });

  it("truncates client_name to 200 chars", () => {
    const r = validateRegisterRequest({
      redirect_uris: ["https://x.test/cb"],
      client_name: "x".repeat(500),
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.record.client_name.length).toBe(200);
  });

  it("defaults client_name to 'unknown' when absent", () => {
    const r = validateRegisterRequest({ redirect_uris: ["https://x.test/cb"] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.record.client_name).toBe("unknown");
  });
});

describe("validateRegisterRequest — rejections", () => {
  it("rejects non-object body", () => {
    expect(validateRegisterRequest("a string").ok).toBe(false);
    expect(validateRegisterRequest(null).ok).toBe(false);
    expect(validateRegisterRequest(42).ok).toBe(false);
  });
  it("rejects missing redirect_uris", () => {
    const r = validateRegisterRequest({ client_name: "x" });
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_redirect_uri");
  });
  it("rejects empty redirect_uris array", () => {
    const r = validateRegisterRequest({ redirect_uris: [] });
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_redirect_uri");
  });
  it("rejects non-https / non-localhost redirect_uri", () => {
    const r = validateRegisterRequest({
      redirect_uris: ["http://attacker.example/cb"],
    });
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_redirect_uri");
  });
  it("rejects malformed URI", () => {
    const r = validateRegisterRequest({ redirect_uris: ["not a url"] });
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toBe("invalid_redirect_uri");
  });
  it("rejects unknown token_endpoint_auth_method", () => {
    const r = validateRegisterRequest({
      redirect_uris: ["https://x.test/cb"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(r.ok).toBe(false);
  });
});

describe("isValidRedirectUri", () => {
  it("accepts https URIs", () => {
    expect(isValidRedirectUri("https://example.com/cb")).toBe(true);
  });
  it("rejects http on non-localhost", () => {
    expect(isValidRedirectUri("http://example.com/cb")).toBe(false);
  });
  it("rejects custom schemes (defer until we have a real native-app caller)", () => {
    expect(isValidRedirectUri("com.example.app://callback")).toBe(false);
  });
});

describe("saveClient + loadClient round-trip", () => {
  it("persists and recovers the full record", async () => {
    const kv = makeMemoryKv();
    const v = validateRegisterRequest({
      redirect_uris: ["https://claude.ai/api/oauth/callback"],
      client_name: "Claude",
    });
    if (!v.ok) throw new Error("expected ok");
    await saveClient(kv, v.record);
    const loaded = await loadClient(kv, v.record.client_id);
    expect(loaded).toEqual(v.record);
  });
  it("returns null for unknown client_id", async () => {
    const kv = makeMemoryKv();
    expect(await loadClient(kv, "mc_nope")).toBeNull();
  });
});

describe("isRegisteredRedirectUri — exact match", () => {
  it("matches verbatim", () => {
    const v = validateRegisterRequest({
      redirect_uris: ["https://claude.ai/api/oauth/callback"],
    });
    if (!v.ok) throw new Error("expected ok");
    expect(isRegisteredRedirectUri(v.record, "https://claude.ai/api/oauth/callback")).toBe(true);
  });
  it("rejects trailing-slash mismatch (RFC 6749 §3.1.2)", () => {
    const v = validateRegisterRequest({
      redirect_uris: ["https://claude.ai/api/oauth/callback"],
    });
    if (!v.ok) throw new Error("expected ok");
    expect(isRegisteredRedirectUri(v.record, "https://claude.ai/api/oauth/callback/")).toBe(false);
  });
  it("rejects query-string mismatch", () => {
    const v = validateRegisterRequest({
      redirect_uris: ["https://claude.ai/api/oauth/callback"],
    });
    if (!v.ok) throw new Error("expected ok");
    expect(
      isRegisteredRedirectUri(v.record, "https://claude.ai/api/oauth/callback?x=1"),
    ).toBe(false);
  });
});
