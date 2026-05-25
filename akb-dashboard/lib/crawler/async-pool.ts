// Bounded-concurrency async pool + global rate gate.
// @agent: scout
//
// Built for the listings-intake Firecrawl loop (sequential @ ~7.5s/call hit
// the 270s wall-clock at ~56% coverage; Standard tier gives 50 concurrent
// browsers). Generic + dependency-injected so the concurrency invariants are
// unit-testable without real timers or network.

export interface AsyncPoolResult<T, R> {
  /** One entry per DISPATCHED item (worker always resolves — the cron's
   *  worker catches internally). Completion order is non-deterministic. */
  results: Array<{ item: T; value: R }>;
  /** Items never dispatched because shouldStopDispatch fired (wall-clock). */
  skipped: T[];
  /** Peak concurrent workers — never exceeds `concurrency` (test invariant). */
  maxInFlight: number;
}

/** Run `worker` over `items` with at most `concurrency` in flight. Before
 *  each dispatch: optionally await `beforeDispatch` (global rate gate) and
 *  check `shouldStopDispatch` (wall-clock) — when it fires, in-flight calls
 *  finish but no new ones dispatch; the rest land in `skipped`. */
export async function runAsyncPool<T, R>(opts: {
  items: T[];
  concurrency: number;
  worker: (item: T) => Promise<R>;
  beforeDispatch?: () => Promise<void> | void;
  shouldStopDispatch?: () => boolean;
}): Promise<AsyncPoolResult<T, R>> {
  const { items, concurrency, worker } = opts;
  const results: Array<{ item: T; value: R }> = [];
  const dispatched = new Set<number>();
  let idx = 0;
  let stopped = false;
  let inFlight = 0;
  let maxInFlight = 0;

  async function runner(): Promise<void> {
    while (true) {
      if (stopped) return;
      if (opts.shouldStopDispatch?.()) {
        stopped = true;
        return;
      }
      const i = idx++; // atomic in single-threaded JS (no await before use)
      if (i >= items.length) return;
      if (opts.beforeDispatch) await opts.beforeDispatch();
      // Re-check after the (possibly long) rate-gate wait: i is consumed but
      // not dispatched → it falls into `skipped` below.
      if (opts.shouldStopDispatch?.()) {
        stopped = true;
        return;
      }
      dispatched.add(i);
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        const value = await worker(items[i]);
        results.push({ item: items[i], value });
      } finally {
        inFlight--;
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => runner()));

  const skipped = items.filter((_, i) => !dispatched.has(i));
  return { results, skipped, maxInFlight };
}

/** Global rate gate: returns an await-able that serializes grants with a
 *  minimum spacing of 60000/perMinute ms, shared across all pool workers.
 *  now + sleep injectable for tests. perMinute <= 0 → no spacing. */
export function makeRateGate(
  perMinute: number,
  deps?: { now?: () => number; sleep?: (ms: number) => Promise<void> },
): () => Promise<void> {
  const now = deps?.now ?? Date.now;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = perMinute > 0 ? 60_000 / perMinute : 0;
  let chain: Promise<void> = Promise.resolve();
  let nextAt = 0;
  return (): Promise<void> => {
    chain = chain.then(async () => {
      const t = now();
      const wait = Math.max(0, nextAt - t);
      if (wait > 0) await sleep(wait);
      nextAt = Math.max(t, nextAt) + intervalMs;
    });
    return chain;
  };
}
