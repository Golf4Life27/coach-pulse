// INV-028 (merged) — Firecrawl 429 backoff helper tests.

import { describe, it, expect } from "vitest";
import {
  parseRetryAfterMs,
  computeRetryDelayMs,
  fetchWithBackoff,
} from "./firecrawl";

interface FakeResp {
  status: number;
  headers: { get(name: string): string | null };
}
function resp(status: number, retryAfter?: string): FakeResp {
  return {
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
  };
}
/** doFetch that returns the given responses in order. */
function sequence(...responses: FakeResp[]): () => Promise<FakeResp> {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}
function recordingSleep() {
  const delays: number[] = [];
  return { sleep: async (ms: number) => { delays.push(ms); }, delays };
}

describe("parseRetryAfterMs", () => {
  it("delta-seconds → ms", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("30")).toBe(30000);
  });
  it("HTTP-date → delta from now", () => {
    const now = new Date("2026-05-25T00:00:00Z");
    expect(parseRetryAfterMs("Mon, 25 May 2026 00:00:05 GMT", now)).toBe(5000);
  });
  it("null / garbage → null", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
  });
});

describe("computeRetryDelayMs", () => {
  it("uses Retry-After when present", () => {
    expect(computeRetryDelayMs(0, 5000, 1000)).toBe(5000);
    expect(computeRetryDelayMs(2, 5000, 1000)).toBe(5000);
  });
  it("exponential backoff when no Retry-After", () => {
    expect(computeRetryDelayMs(0, null, 1000)).toBe(1000);
    expect(computeRetryDelayMs(1, null, 1000)).toBe(2000);
    expect(computeRetryDelayMs(2, null, 1000)).toBe(4000);
  });
});

describe("fetchWithBackoff", () => {
  it("200 first try → no retry, no sleep", async () => {
    const { sleep, delays } = recordingSleep();
    const r = await fetchWithBackoff({ doFetch: sequence(resp(200)), sleep });
    expect(r.response.status).toBe(200);
    expect(r.attempts).toBe(1);
    expect(r.retried429).toBe(0);
    expect(delays).toEqual([]);
  });

  it("429 WITH retry-after header → honors it, then 200", async () => {
    const { sleep, delays } = recordingSleep();
    const r = await fetchWithBackoff({
      doFetch: sequence(resp(429, "2"), resp(200)),
      sleep,
      baseDelayMs: 1000,
    });
    expect(r.response.status).toBe(200);
    expect(r.retried429).toBe(1);
    expect(delays).toEqual([2000]); // from retry-after, not exponential
  });

  it("429 WITHOUT retry-after → exponential backoff, then 200", async () => {
    const { sleep, delays } = recordingSleep();
    const r = await fetchWithBackoff({
      doFetch: sequence(resp(429), resp(200)),
      sleep,
      baseDelayMs: 1000,
    });
    expect(r.response.status).toBe(200);
    expect(r.retried429).toBe(1);
    expect(delays).toEqual([1000]); // base * 2^0
  });

  it("429 → 429 → 200 (two retries, escalating backoff)", async () => {
    const { sleep, delays } = recordingSleep();
    const r = await fetchWithBackoff({
      doFetch: sequence(resp(429), resp(429), resp(200)),
      sleep,
      baseDelayMs: 1000,
    });
    expect(r.response.status).toBe(200);
    expect(r.retried429).toBe(2);
    expect(delays).toEqual([1000, 2000]); // 2^0, 2^1
  });

  it("exhausted retries → returns final 429", async () => {
    const { sleep, delays } = recordingSleep();
    const r = await fetchWithBackoff({
      doFetch: sequence(resp(429), resp(429), resp(429), resp(429)),
      sleep,
      maxRetries: 3,
      baseDelayMs: 1000,
    });
    expect(r.response.status).toBe(429);
    expect(r.retried429).toBe(3);
    expect(r.attempts).toBe(4); // initial + 3 retries
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("non-429 error (500) is NOT retried", async () => {
    const { sleep, delays } = recordingSleep();
    const r = await fetchWithBackoff({ doFetch: sequence(resp(500)), sleep });
    expect(r.response.status).toBe(500);
    expect(r.retried429).toBe(0);
    expect(delays).toEqual([]);
  });
});
