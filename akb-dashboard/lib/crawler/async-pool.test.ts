// Bounded-concurrency pool + rate-gate tests.

import { describe, it, expect } from "vitest";
import { runAsyncPool, makeRateGate } from "./async-pool";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("runAsyncPool — concurrency invariants", () => {
  it("N < concurrency → all dispatched, maxInFlight ≤ N", async () => {
    const items = [1, 2, 3];
    const r = await runAsyncPool({
      items,
      concurrency: 20,
      worker: async (n) => { await delay(5); return n * 2; },
    });
    expect(r.results).toHaveLength(3);
    expect(r.skipped).toHaveLength(0);
    expect(r.maxInFlight).toBeLessThanOrEqual(3);
    expect(r.results.map((x) => x.value).sort((a, b) => a - b)).toEqual([2, 4, 6]);
  });

  it("N > concurrency → in-flight never exceeds concurrency", async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    let active = 0;
    let observedMax = 0;
    const r = await runAsyncPool({
      items,
      concurrency: 5,
      worker: async (n) => {
        active++;
        observedMax = Math.max(observedMax, active);
        await delay(10);
        active--;
        return n;
      },
    });
    expect(r.results).toHaveLength(30);
    expect(observedMax).toBe(5); // exactly the cap with 30 items
    expect(r.maxInFlight).toBe(5);
  });

  it("one slow call does NOT block others (no head-of-line)", async () => {
    const items = ["slow", "f1", "f2", "f3"];
    const completion: string[] = [];
    const r = await runAsyncPool({
      items,
      concurrency: 4,
      worker: async (s) => {
        await delay(s === "slow" ? 80 : 5);
        completion.push(s);
        return s;
      },
    });
    expect(r.results).toHaveLength(4);
    // Fast items complete before the slow one despite being dispatched together.
    expect(completion.indexOf("slow")).toBe(completion.length - 1);
    expect(completion.slice(0, 3).sort()).toEqual(["f1", "f2", "f3"]);
  });

  it("mixed worker outcomes all land in results (aggregation is caller's job)", async () => {
    const items = ["ok", "rate", "err", "ok2"];
    const r = await runAsyncPool({
      items,
      concurrency: 2,
      worker: async (s) => {
        await delay(3);
        if (s === "rate") return { kind: "429" };
        if (s === "err") return { kind: "error" };
        return { kind: "ok" };
      },
    });
    expect(r.results).toHaveLength(4);
    const kinds = r.results.map((x) => x.value.kind).sort();
    expect(kinds).toEqual(["429", "error", "ok", "ok"]);
  });

  it("wall-clock stop → in-flight complete, undispatched → skipped", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let done = 0;
    const r = await runAsyncPool({
      items,
      concurrency: 2,
      shouldStopDispatch: () => done >= 3, // stop dispatching after 3 complete
      worker: async (n) => { await delay(5); done++; return n; },
    });
    // Every item is either a result or skipped — none lost.
    expect(r.results.length + r.skipped.length).toBe(10);
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(r.maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe("makeRateGate — global spacing across workers", () => {
  it("spaces grants by 60000/perMinute using injected clock", async () => {
    let clock = 0;
    const slept: number[] = [];
    const gate = makeRateGate(60, {
      now: () => clock,
      sleep: async (ms) => { slept.push(ms); clock += ms; },
    });
    await gate(); // t=0, no wait, next=1000
    await gate(); // t=0, wait 1000, next=2000
    await gate(); // t=1000, wait 1000, next=3000
    expect(slept).toEqual([1000, 1000]); // first grant had no wait
    expect(clock).toBe(2000);
  });

  it("perMinute<=0 → no spacing", async () => {
    const slept: number[] = [];
    const gate = makeRateGate(0, { now: () => 0, sleep: async (ms) => { slept.push(ms); } });
    await gate();
    await gate();
    expect(slept).toEqual([]);
  });

  it("serializes concurrent gate() calls (shared chain)", async () => {
    let clock = 0;
    const slept: number[] = [];
    const gate = makeRateGate(120, { // interval 500ms
      now: () => clock,
      sleep: async (ms) => { slept.push(ms); clock += ms; },
    });
    // Fire 4 in parallel — the gate must serialize them with 500ms spacing.
    await Promise.all([gate(), gate(), gate(), gate()]);
    expect(slept).toEqual([500, 500, 500]); // grants 2,3,4 each wait one interval
  });
});
