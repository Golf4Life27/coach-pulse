// @agent: maverick — auth waterfall tests.

import { describe, it, expect } from "vitest";
import {
  authenticate,
  buildWwwAuthenticate,
  hasDashboardSession,
  type AuthEnv,
  type AuthHeaders,
} from "./auth-waterfall";
import { issueTokenPair } from "./tokens";
import { makeMemoryKv, type KvClient } from "./kv";

function envOver(over: Partial<AuthEnv> = {}): AuthEnv {
  return {
    cronSecret: null,
    bearerDevToken: null,
    isProduction: false,
    ...over,
  };
}

function headers(over: Partial<AuthHeaders> = {}): AuthHeaders {
  return { authorization: null, x_vercel_cron: null, ...over };
}

describe("authenticate — header parsing", () => {
  it("rejects when Authorization header missing", async () => {
    const r = await authenticate(headers(), envOver(), makeMemoryKv());
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("no_authorization_header");
  });
  it("rejects on non-Bearer scheme", async () => {
    const r = await authenticate(
      headers({ authorization: "Basic abc" }),
      envOver(),
      makeMemoryKv(),
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("malformed_authorization_header");
  });
  it("rejects on empty token after 'Bearer '", async () => {
    const r = await authenticate(
      headers({ authorization: "Bearer " }),
      envOver(),
      makeMemoryKv(),
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("malformed_authorization_header");
  });
});

describe("authenticate — stage 1: OAuth opaque token", () => {
  async function setupAccessToken(kv: KvClient) {
    const pair = await issueTokenPair(kv, {
      client_id: "mc_x",
      subject: "alex",
      scope: "maverick:state",
    });
    return pair.access.token;
  }

  it("grants when access token exists + is unexpired", async () => {
    const kv = makeMemoryKv();
    const token = await setupAccessToken(kv);
    const r = await authenticate(
      headers({ authorization: `Bearer ${token}` }),
      envOver(),
      kv,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.kind).toBe("oauth");
    if (r.kind === "oauth") {
      expect(r.subject).toBe("alex");
      expect(r.client_id).toBe("mc_x");
    }
  });

  it("rejects unknown mat_ token with oauth_token_unknown", async () => {
    const r = await authenticate(
      headers({ authorization: "Bearer mat_unknown_token_value_here" }),
      envOver(),
      makeMemoryKv(),
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("oauth_token_unknown");
  });

  it("rejects expired access token with oauth_token_expired", async () => {
    const kv = makeMemoryKv();
    const pastIssue = new Date("2024-01-01T00:00:00Z");
    const pair = await issueTokenPair(
      kv,
      { client_id: "mc_x", subject: "alex", scope: "maverick:state" },
      pastIssue,
    );
    const r = await authenticate(
      headers({ authorization: `Bearer ${pair.access.token}` }),
      envOver(),
      kv,
      new Date(),
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("oauth_token_expired");
  });
});

describe("authenticate — stage 2: CRON_SECRET", () => {
  it("grants when CRON_SECRET matches + x-vercel-cron:1 present", async () => {
    const r = await authenticate(
      headers({ authorization: "Bearer cron-secret-value", x_vercel_cron: "1" }),
      envOver({ cronSecret: "cron-secret-value" }),
      makeMemoryKv(),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.kind).toBe("cron");
  });

  it("rejects when CRON_SECRET matches BUT x-vercel-cron header is missing", async () => {
    const r = await authenticate(
      headers({ authorization: "Bearer cron-secret-value" }),
      envOver({ cronSecret: "cron-secret-value" }),
      makeMemoryKv(),
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("cron_secret_match_without_x_vercel_cron");
  });

  it("rejects when CRON_SECRET is unset (skipped)", async () => {
    const r = await authenticate(
      headers({ authorization: "Bearer cron-secret-value", x_vercel_cron: "1" }),
      envOver({ cronSecret: null }),
      makeMemoryKv(),
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("no_credential_matched");
  });
});

describe("authenticate — stage 3: bearer dev fallback", () => {
  it("grants when MAVERICK_MCP_TOKEN matches + NODE_ENV !== production", async () => {
    const r = await authenticate(
      headers({ authorization: "Bearer dev-token" }),
      envOver({ bearerDevToken: "dev-token", isProduction: false }),
      makeMemoryKv(),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.kind).toBe("bearer_dev");
  });

  it("REFUSES in production even when token matches (defense vs env-var leak)", async () => {
    const r = await authenticate(
      headers({ authorization: "Bearer dev-token" }),
      envOver({ bearerDevToken: "dev-token", isProduction: true }),
      makeMemoryKv(),
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("bearer_dev_blocked_in_production");
  });
});

describe("authenticate — waterfall ordering", () => {
  it("OAuth match short-circuits past CRON_SECRET check", async () => {
    const kv = makeMemoryKv();
    const pair = await issueTokenPair(kv, {
      client_id: "mc_x",
      subject: "alex",
      scope: "maverick:state",
    });
    const r = await authenticate(
      headers({ authorization: `Bearer ${pair.access.token}` }),
      envOver({ cronSecret: "ignored", bearerDevToken: "ignored" }),
      kv,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.kind).toBe("oauth");
  });

  it("returns no_credential_matched when nothing matches", async () => {
    const r = await authenticate(
      headers({ authorization: "Bearer random-junk" }),
      envOver({ cronSecret: "different", bearerDevToken: "also-different" }),
      makeMemoryKv(),
    );
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("no_credential_matched");
  });
});

describe("hasDashboardSession — same-origin cookie check", () => {
  it("returns false on null cookie header", () => {
    expect(hasDashboardSession(null)).toBe(false);
  });
  it("returns true when the session marker is the only cookie", () => {
    expect(hasDashboardSession("akb-auth=authenticated")).toBe(true);
  });
  it("returns true when the session marker is one of multiple cookies", () => {
    expect(
      hasDashboardSession("other=xyz; akb-auth=authenticated; foo=bar"),
    ).toBe(true);
  });
  it("returns true when there are extra spaces around the separator", () => {
    expect(
      hasDashboardSession("  other=xyz ;   akb-auth=authenticated  "),
    ).toBe(true);
  });
  it("rejects partial-value matches (no substring-attack risk)", () => {
    expect(
      hasDashboardSession("akb-auth=authenticated-suffix"),
    ).toBe(false);
    expect(
      hasDashboardSession("not-akb-auth=authenticated"),
    ).toBe(false);
  });
  it("rejects wrong value", () => {
    expect(hasDashboardSession("akb-auth=guest")).toBe(false);
  });
  it("returns false on malformed cookie pairs (no equals sign)", () => {
    expect(hasDashboardSession("akb-auth")).toBe(false);
    expect(hasDashboardSession(";;;")).toBe(false);
  });
});

describe("buildWwwAuthenticate", () => {
  it("includes Bearer realm + error + resource_metadata pointing to discovery", () => {
    const h = buildWwwAuthenticate("https://example.com", "no_credential_matched");
    expect(h).toMatch(/Bearer realm="maverick"/);
    expect(h).toMatch(/error="invalid_request"/);
    expect(h).toMatch(
      /resource_metadata="https:\/\/example\.com\/\.well-known\/oauth-protected-resource"/,
    );
  });
  it("uses invalid_token error code for token-related failures", () => {
    expect(buildWwwAuthenticate("https://x.test", "oauth_token_expired")).toMatch(
      /error="invalid_token"/,
    );
    expect(buildWwwAuthenticate("https://x.test", "oauth_token_unknown")).toMatch(
      /error="invalid_token"/,
    );
  });
});
