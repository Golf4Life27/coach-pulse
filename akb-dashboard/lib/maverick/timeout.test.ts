// @agent: maverick — timeout helper tests.

import { describe, it, expect } from "vitest";
import { runWithTimeout } from "./timeout";

describe("runWithTimeout", () => {
  it("returns succeed-shaped result when the producer resolves in time", async () => {
    const r = await runWithTimeout(
      { source: "git", timeoutMs: 1_000 },
      async () => ({ branch: "test" }),
    );
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ branch: "test" });
    expect(r.error).toBeNull();
    expect(r.source).toBe("git");
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    expect(r.served_from_cache).toBe(false);
  });

  it("returns failResult with timeout message when the producer exceeds the budget", async () => {
    const r = await runWithTimeout(
      { source: "external_quo", timeoutMs: 50 },
      async (signal) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 200);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
        return "should-not-return";
      },
    );
    expect(r.ok).toBe(false);
    expect(r.data).toBeNull();
    expect(r.error).toMatch(/timeout after 50ms|aborted/i);
    expect(r.source).toBe("external_quo");
  });

  it("propagates the producer's error message into failResult", async () => {
    const r = await runWithTimeout(
      { source: "airtable_listings", timeoutMs: 1_000 },
      async () => {
        throw new Error("airtable 502");
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("airtable 502");
  });

  it("propagates the abort signal so producers can cancel inflight I/O", async () => {
    let aborted = false;
    const r = await runWithTimeout(
      { source: "git", timeoutMs: 30 },
      async (signal) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 200);
          signal.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
        return null;
      },
    );
    expect(r.ok).toBe(false);
    expect(aborted).toBe(true);
  });

  it("forwards stalenessSeconds from RunOpts to succeed-path result", async () => {
    const r = await runWithTimeout(
      { source: "vercel_kv_audit", timeoutMs: 1_000, stalenessSeconds: 45 },
      async () => ({ events: [] }),
    );
    expect(r.staleness_seconds).toBe(45);
  });
});
