// KV-backed behavior of the billing-period meter (fixed 2026-09-24 — see
// the RENTCAST_MONTHLY_CAP comment in spend-ceiling.ts). Split from
// spend-ceiling.test.ts because it needs to mock the KV client; the pure
// tests there don't touch KV at all.

import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();

vi.mock("@/lib/maverick/oauth/kv", () => ({
  kvConfigured: () => true,
  kvProd: {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async incrBy(key: string, amount: number) {
      const next = (Number(store.get(key)) || 0) + amount;
      store.set(key, String(next));
      return next;
    },
    async expire() {
      /* no-op — TTL isn't observable in this fake */
    },
  },
}));

import { recordKvSpend, readKvSpend, periodKey, __resetInvocationCounter } from "./spend-ceiling";

describe("recordKvSpend / readKvSpend — billing period, not calendar month", () => {
  beforeEach(() => {
    store.clear();
    __resetInvocationCounter();
  });

  it("recordKvSpend writes the period key (rc:spend:p:<anchor date>), not rc:spend:m:*", async () => {
    const now = new Date("2026-09-22T12:00:00.000Z");
    await recordKvSpend(now);
    expect(store.has(periodKey(now))).toBe(true);
    expect(periodKey(now)).toBe("rc:spend:p:2026-09-11");
    expect([...store.keys()].some((k) => k.startsWith("rc:spend:m:"))).toBe(false);
  });

  it("readKvSpend's month field reads back the period counter", async () => {
    const now = new Date("2026-09-22T12:00:00.000Z");
    await recordKvSpend(now);
    await recordKvSpend(now);
    const spend = await readKvSpend(now);
    expect(spend.month).toBe(2);
    expect(spend.kvAvailable).toBe(true);
  });

  it("a call just before the anchor and a call just after land in different periods", async () => {
    const beforeAnchor = new Date("2026-09-10T23:59:00.000Z");
    const afterAnchor = new Date("2026-09-11T00:00:01.000Z");
    await recordKvSpend(beforeAnchor);
    await recordKvSpend(afterAnchor);
    expect((await readKvSpend(beforeAnchor)).month).toBe(1);
    expect((await readKvSpend(afterAnchor)).month).toBe(1);
  });
});
