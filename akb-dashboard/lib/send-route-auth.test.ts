// Coverage for the shared write-route guard (requireSendAuth) — the single
// waterfall every newly-guarded route in this security sweep calls
// (2026-09-24, execution agenda P0-21, spine recYbAYqkguZSOTeF).
//
// Three credential classes, any one of which authenticates:
//   1. the dashboard session cookie (akb-auth)
//   2. a CRON_SECRET bearer token (Vercel cron / GitHub Actions workflows)
//   3. an OAuth access token or MAVERICK_MCP_TOKEN dev bearer (see
//      lib/maverick/oauth/auth-waterfall.authenticate, covered by its own
//      auth-waterfall.test.ts)
//
// requireSendAuth also has a "nothing configured" escape hatch (dev/CI with
// no CRON_SECRET, no KV, no dev token) so local dev isn't locked out; that
// path is exercised explicitly below too.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireSendAuth } from "./send-route-auth";
import { mintSessionValue, sessionSecret, SESSION_COOKIE_NAME } from "@/lib/auth/session-cookie";

const ENV_KEYS = [
  "CRON_SECRET",
  "MAVERICK_MCP_TOKEN",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_SESSION_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Deterministic starting point: nothing configured, KV never configured
  // in this test process (no real Upstash creds).
  delete process.env.CRON_SECRET;
  delete process.env.MAVERICK_MCP_TOKEN;
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_SESSION_SECRET;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function req(init?: { headers?: Record<string, string> }): Request {
  return new Request("https://dashboard.example/api/whatever", {
    method: "POST",
    headers: init?.headers ?? {},
  });
}

function dashboardCookieHeader(): string {
  process.env.DASHBOARD_PASSWORD = "test-password-for-ci";
  const secret = sessionSecret();
  if (!secret) throw new Error("test setup: sessionSecret() returned null");
  const value = mintSessionValue(Date.now() + 90 * 24 * 60 * 60 * 1000, secret);
  return `${SESSION_COOKIE_NAME}=${value}`;
}

describe("requireSendAuth", () => {
  it("rejects an unauthenticated request with 401 when a credential is configured", async () => {
    process.env.CRON_SECRET = "a-cron-secret-that-is-long-enough-1234567890";
    const result = await requireSendAuth(req());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it("accepts a valid dashboard session cookie", async () => {
    process.env.CRON_SECRET = "a-cron-secret-that-is-long-enough-1234567890";
    const cookie = dashboardCookieHeader();
    const result = await requireSendAuth(req({ headers: { cookie } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.authKind).toBe("dashboard_session");
  });

  it("rejects a forged/garbage dashboard session cookie", async () => {
    process.env.CRON_SECRET = "a-cron-secret-that-is-long-enough-1234567890";
    process.env.DASHBOARD_PASSWORD = "test-password-for-ci";
    const result = await requireSendAuth(
      req({ headers: { cookie: `${SESSION_COOKIE_NAME}=authenticated` } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("accepts the correct CRON_SECRET bearer token", async () => {
    process.env.CRON_SECRET = "a-cron-secret-that-is-long-enough-1234567890";
    const result = await requireSendAuth(
      req({ headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.authKind).toBe("cron");
  });

  it("rejects an incorrect bearer token even when it is a substring/superstring of the real secret", async () => {
    process.env.CRON_SECRET = "a-cron-secret-that-is-long-enough-1234567890";
    // Regression guard for the exact class of bug fixed in
    // admin/migrate-dd-checklist (`auth.includes(secret)` accepted any
    // header containing the secret as a substring).
    const result = await requireSendAuth(
      req({ headers: { authorization: `Bearer XXX${process.env.CRON_SECRET}XXX` } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects a truncated bearer token (prefix of the real secret)", async () => {
    process.env.CRON_SECRET = "a-cron-secret-that-is-long-enough-1234567890";
    const truncated = process.env.CRON_SECRET.slice(0, -1);
    const result = await requireSendAuth(req({ headers: { authorization: `Bearer ${truncated}` } }));
    expect(result.ok).toBe(false);
  });

  it("allows the request through when no credential is configured at all (dev/CI escape hatch)", async () => {
    // No CRON_SECRET, no KV, no MAVERICK_MCP_TOKEN — matches an
    // unconfigured dev/CI environment. The route must still be reachable
    // there (this mirrors the pre-existing behavior of jarvis-send /
    // dd-volley-send / buyers/fire-blast, the three routes this helper
    // was originally written for).
    const result = await requireSendAuth(req());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.authKind).toBe("none_configured");
  });
});
