// Unit tests for the in-memory KV client — focused on setNx, the atomic
// acquire primitive backing the H2 dispatch idempotency lock.

import { describe, it, expect } from "vitest";
import { makeMemoryKv } from "./kv";

describe("makeMemoryKv — setNx (atomic acquire)", () => {
  it("acquires when the key is absent, refuses when held", async () => {
    const kv = makeMemoryKv();
    expect(await kv.setNx("lock", "a", 60)).toBe(true); // first acquire wins
    expect(await kv.setNx("lock", "b", 60)).toBe(false); // second is blocked
    expect(await kv.get("lock")).toBe("a"); // value not overwritten by the failed acquire
  });

  it("re-acquires after the TTL expires", async () => {
    const kv = makeMemoryKv();
    expect(await kv.setNx("lock", "a", 0)).toBe(true); // 0s TTL → immediately expired
    expect(await kv.setNx("lock", "b", 60)).toBe(true); // expired key is acquirable again
    expect(await kv.get("lock")).toBe("b");
  });

  it("re-acquires after an explicit release (del)", async () => {
    const kv = makeMemoryKv();
    expect(await kv.setNx("claim", "x", 60)).toBe(true);
    expect(await kv.setNx("claim", "y", 60)).toBe(false);
    await kv.del("claim"); // release (mirrors send-failure rollback)
    expect(await kv.setNx("claim", "z", 60)).toBe(true);
  });

  it("locks are independent per key", async () => {
    const kv = makeMemoryKv();
    expect(await kv.setNx("h2:dispatch:rec1", "t", 60)).toBe(true);
    expect(await kv.setNx("h2:dispatch:rec2", "t", 60)).toBe(true); // different record, free
    expect(await kv.setNx("h2:dispatch:rec1", "t", 60)).toBe(false); // same record, held
  });
});
