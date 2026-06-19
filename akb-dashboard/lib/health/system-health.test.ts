// System health check — unit tests. Proves the preamble is FAIL-CLOSED:
// KV down or breaker tripped => halt; low balance => advisory warning only.

import { describe, it, expect, vi } from "vitest";
import { checkSystemHealth, type HealthDeps } from "./system-health";
import { makeMemoryKv, type KvClient } from "@/lib/maverick/oauth/kv";

function deps(over: Partial<HealthDeps> = {}): HealthDeps {
  return {
    kvConfigured: () => true,
    kv: makeMemoryKv(),
    checkBreaker: async () => ({ tripped: false, spentRecent: 0, cap: 800, headroom: 800 }),
    probeBalance: async () => ({ remaining: 14000, error: null }),
    now: () => new Date("2026-06-18T00:00:00.000Z"),
    ...over,
  };
}

describe("checkSystemHealth", () => {
  it("all green => healthy, no halt", async () => {
    const h = await checkSystemHealth(deps());
    expect(h.halt).toBe(false);
    expect(h.healthy).toBe(true);
    expect(h.kv.reachable).toBe(true);
    expect(h.firecrawl.breakerTripped).toBe(false);
  });

  it("HALT when KV is not configured", async () => {
    const h = await checkSystemHealth(deps({ kvConfigured: () => false }));
    expect(h.halt).toBe(true);
    expect(h.haltReasons).toContain("kv_not_configured");
  });

  it("HALT when KV is unreachable (round-trip throws)", async () => {
    const throwingKv: KvClient = {
      ...makeMemoryKv(),
      get: async () => { throw new Error("KV get failed: 500"); },
    };
    const h = await checkSystemHealth(deps({ kv: throwingKv }));
    expect(h.halt).toBe(true);
    expect(h.haltReasons).toContain("kv_unreachable");
    expect(h.kv.reachable).toBe(false);
  });

  it("HALT when the Firecrawl breaker is tripped", async () => {
    const h = await checkSystemHealth(deps({
      checkBreaker: async () => ({ tripped: true, spentRecent: 900, cap: 800, headroom: 0 }),
    }));
    expect(h.halt).toBe(true);
    expect(h.haltReasons).toContain("firecrawl_breaker_tripped");
  });

  it("FAIL-CLOSED when the breaker read itself throws", async () => {
    const h = await checkSystemHealth(deps({
      checkBreaker: async () => { throw new Error("kv down"); },
    }));
    expect(h.halt).toBe(true);
    expect(h.haltReasons.some((r) => r.startsWith("firecrawl_breaker_check_failed"))).toBe(true);
  });

  it("non-positive balance is an ADVISORY warning, not a halt", async () => {
    const h = await checkSystemHealth(deps({
      probeBalance: async () => ({ remaining: 0, error: null }),
    }));
    expect(h.halt).toBe(false);
    expect(h.healthy).toBe(false); // green requires no warnings
    expect(h.warnings).toContain("firecrawl_balance_nonpositive");
  });
});
