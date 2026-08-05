// The spend meter must not lose concurrent increments (2026-08-04).
//
// VERIFIED AGAINST THE VENDOR: RentCast's own dashboard reported 117 calls
// used of 1,000 with 79 in the last day, while the KV month meter read ~27.
// The meter was undercounting roughly 4x, so the ceiling never tripped —
// zero HTTP-598 rows all day on a plan already running over pace.
//
// Cause: get → add → setEx in application space. Every lambda that read the
// same `prev` wrote the same `prev + 1`, so N overlapping calls recorded ONE.
// A brake that undercounts is a brake that does not engage.

import { describe, it, expect } from "vitest";
import { makeMemoryKv } from "@/lib/maverick/oauth/kv";

describe("KV counter atomicity", () => {
  it("records every concurrent increment (the old get+setEx lost them)", async () => {
    const kv = makeMemoryKv();
    const N = 50;
    await Promise.all(Array.from({ length: N }, () => kv.incrBy("rc:spend:m:2026-08", 1)));
    expect(Number(await kv.get("rc:spend:m:2026-08"))).toBe(N);
  });

  it("demonstrates the bug the fix replaces", async () => {
    const kv = makeMemoryKv();
    const N = 50;
    // The old shape: read, then write read+1. Interleaved, all 50 read 0.
    await Promise.all(
      Array.from({ length: N }, async () => {
        const prev = Number((await kv.get("old")) ?? "0") || 0;
        await kv.setEx("old", String(prev + 1), 60);
      }),
    );
    const recorded = Number(await kv.get("old"));
    expect(recorded).toBeLessThan(N);
    expect(recorded).toBe(1); // 50 real calls, 1 recorded — a 50x undercount
  });

  it("incrBy carries the crawl meter's multi-unit increments", async () => {
    const kv = makeMemoryKv();
    await Promise.all([kv.incrBy("crawl", 8), kv.incrBy("crawl", 2), kv.incrBy("crawl", 1)]);
    expect(Number(await kv.get("crawl"))).toBe(11);
  });

  it("expire attaches a TTL only after the counter exists", async () => {
    const kv = makeMemoryKv();
    const first = await kv.incrBy("k", 1);
    expect(first).toBe(1);
    await kv.expire("k", 60);
    expect(await kv.get("k")).toBe("1");
  });

  it("a later increment does not reset the window", async () => {
    const kv = makeMemoryKv();
    await kv.incrBy("k", 1);
    await kv.expire("k", 60);
    const second = await kv.incrBy("k", 1);
    expect(second).toBe(2);
  });
});
