// @agent: scout — Gmail thread fetch tests (2026-09-22 bug hunt).
//
// getThreadById used to swallow ANY non-ok HTTP response into `[]` with
// only a console.error — indistinguishable from "thread has no messages".
// That's exactly how the Julius Florendo / Jacob Horn buy-box drip replies
// went missing: the reply WAS on the thread, but if the fetch had failed
// for any reason, the caller would see the same empty array either way.
// getThreadByIdResult reports the outcome instead.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENV_KEYS = ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const;

function setGmailEnv() {
  process.env.GMAIL_OAUTH_CLIENT_ID = "test-client-id";
  process.env.GMAIL_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.GMAIL_REFRESH_TOKEN = "test-refresh-token";
}

function clearGmailEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

async function freshGmailModule() {
  vi.resetModules();
  return import("./gmail");
}

function tokenResponse(accessToken = "fake-access-token-xyz") {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), { status: 200 });
}

function base64Url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fullMessage(opts: { id: string; threadId: string; from: string; subject: string; body: string; internalDate: string }) {
  return {
    id: opts.id,
    threadId: opts.threadId,
    internalDate: opts.internalDate,
    payload: {
      headers: [
        { name: "Subject", value: opts.subject },
        { name: "From", value: opts.from },
        { name: "To", value: "buyer@example.com" },
      ],
      mimeType: "text/plain",
      body: { data: base64Url(opts.body) },
    },
  };
}

describe("getThreadByIdResult", () => {
  beforeEach(() => setGmailEnv());
  afterEach(() => {
    vi.unstubAllGlobals();
    clearGmailEnv();
  });

  it("reports the HTTP status on a non-ok fetch instead of swallowing it into []", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse();
      return new Response("forbidden", { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadByIdResult } = await freshGmailModule();

    const r = await getThreadByIdResult("thread123");
    expect(r.messages).toEqual([]);
    expect(r.status).toBe(403);
    expect(r.error).toBe("gmail_thread_fetch_403");
  });

  it("never leaks the access token, refresh token, or client secret into the error string", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse("super-secret-access-token");
      // A real Google error body could echo back request details — the
      // error string returned to callers must never carry any of it.
      return new Response(
        JSON.stringify({ error: { message: "invalid_grant for token super-secret-access-token / test-refresh-token" } }),
        { status: 401 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadByIdResult } = await freshGmailModule();

    const r = await getThreadByIdResult("thread123");
    expect(r.error).toBe("gmail_thread_fetch_401");
    expect(r.error).not.toContain("super-secret-access-token");
    expect(r.error).not.toContain("test-refresh-token");
    expect(r.error).not.toContain("test-client-secret");
  });

  it("reports gmail_not_configured (no HTTP call) when env is missing, never an empty error", async () => {
    clearGmailEnv();
    const fetchMock = vi.fn(async () => new Response("should not be called", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadByIdResult } = await freshGmailModule();

    const r = await getThreadByIdResult("thread123");
    expect(r.messages).toEqual([]);
    expect(r.status).toBeNull();
    expect(r.error).toBe("gmail_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns messages oldest-first with error null on success", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse();
      return new Response(
        JSON.stringify({
          messages: [
            fullMessage({ id: "m2", threadId: "t1", from: "buyer@example.com", subject: "Re: box", body: "second", internalDate: "1758556800000" }),
            fullMessage({ id: "m1", threadId: "t1", from: "alex@akb-properties.com", subject: "box", body: "first", internalDate: "1758470400000" }),
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadByIdResult } = await freshGmailModule();

    const r = await getThreadByIdResult("t1");
    expect(r.error).toBeNull();
    expect(r.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("empty thread id is an error, not a silent []", async () => {
    const { getThreadByIdResult } = await freshGmailModule();
    const r = await getThreadByIdResult("");
    expect(r.error).toBe("empty_thread_id");
    expect(r.messages).toEqual([]);
  });
});

describe("getThreadByIdResult rate-limit retry (2026-09-22 pacing fix)", () => {
  beforeEach(() => {
    setGmailEnv();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearGmailEnv();
  });

  function rateLimitedResponse(status = 403, reason = "rateLimitExceeded") {
    return new Response(JSON.stringify({ error: { errors: [{ reason }], status: "RESOURCE_EXHAUSTED" } }), { status });
  }

  it("retries a 403 rateLimitExceeded and succeeds on the next attempt", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse();
      apiCalls++;
      if (apiCalls === 1) return rateLimitedResponse();
      return new Response(
        JSON.stringify({
          messages: [fullMessage({ id: "m1", threadId: "t1", from: "buyer@example.com", subject: "box", body: "hi", internalDate: "1758470400000" })],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadByIdResult } = await freshGmailModule();

    const resultPromise = getThreadByIdResult("thread123");
    await vi.runAllTimersAsync();
    const r = await resultPromise;

    expect(r.error).toBeNull();
    expect(r.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(apiCalls).toBe(2);
  });

  it("retries a 403 rateLimitExceeded up to the cap, then reports gmail_thread_fetch_403_rate_limited with exactly 4 fetches", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse();
      apiCalls++;
      return rateLimitedResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadByIdResult } = await freshGmailModule();

    const resultPromise = getThreadByIdResult("thread123");
    await vi.runAllTimersAsync();
    const r = await resultPromise;

    expect(r.error).toBe("gmail_thread_fetch_403_rate_limited");
    expect(r.status).toBe(403);
    expect(r.messages).toEqual([]);
    expect(apiCalls).toBe(4);
  });

  it("retries a 429 the same way", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse();
      apiCalls++;
      if (apiCalls < 3) return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadByIdResult } = await freshGmailModule();

    const resultPromise = getThreadByIdResult("thread123");
    await vi.runAllTimersAsync();
    const r = await resultPromise;

    expect(r.error).toBeNull();
    expect(apiCalls).toBe(3);
  });

  it("does NOT retry a non-rate-limit 403 (insufficientPermissions) — immediate failure, one fetch", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse();
      apiCalls++;
      return new Response(JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadByIdResult } = await freshGmailModule();

    const resultPromise = getThreadByIdResult("thread123");
    await vi.runAllTimersAsync();
    const r = await resultPromise;

    expect(r.error).toBe("gmail_thread_fetch_403");
    expect(apiCalls).toBe(1);
  });

  it("never leaks body text or the token through the rate-limited retry path", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse("super-secret-access-token");
      return new Response(
        JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }], message: "token super-secret-access-token / test-refresh-token" } }),
        { status: 403 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadByIdResult } = await freshGmailModule();

    const resultPromise = getThreadByIdResult("thread123");
    await vi.runAllTimersAsync();
    const r = await resultPromise;

    expect(r.error).toBe("gmail_thread_fetch_403_rate_limited");
    expect(r.error).not.toContain("super-secret-access-token");
    expect(r.error).not.toContain("test-refresh-token");
    expect(r.error).not.toContain("test-client-secret");
  });
});

describe("getThreadById (thin wrapper)", () => {
  beforeEach(() => setGmailEnv());
  afterEach(() => {
    vi.unstubAllGlobals();
    clearGmailEnv();
  });

  it("still returns [] on a fetch failure, for callers that only want the messages", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse();
      return new Response("nope", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadById } = await freshGmailModule();

    const msgs = await getThreadById("thread123");
    expect(msgs).toEqual([]);
  });

  it("returns the messages on success", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse();
      return new Response(
        JSON.stringify({
          messages: [fullMessage({ id: "m1", threadId: "t1", from: "buyer@example.com", subject: "box", body: "hi", internalDate: "1758470400000" })],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getThreadById } = await freshGmailModule();

    const msgs = await getThreadById("t1");
    expect(msgs.map((m) => m.id)).toEqual(["m1"]);
  });
});
