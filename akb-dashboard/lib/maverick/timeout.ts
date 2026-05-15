// Maverick — bounded-timeout helper.
// @agent: maverick
//
// Every Maverick source fetcher must respect a per-source timeout
// budget (Spec v1.1 §5 Step 1 performance table). withTimeout()
// races the underlying promise against a timer and returns a
// SourceResult<T> on either path — never throws to the aggregator.
//
// Pure-function-shaped. Tested under lib/maverick/timeout.test.ts.

import {
  failResult,
  succeed,
  type SourceName,
  type SourceResult,
} from "./types";

export interface RunOpts {
  source: SourceName;
  timeoutMs: number;
  // Static-known staleness — for fetchers that surface a "data is
  // N seconds old at the source" signal (rare today; reserved for
  // future cache-backed fetchers). Defaults to 0 (data treated as
  // current as of fetch).
  stalenessSeconds?: number;
}

/**
 * Race a producer promise against a timeout. The producer is
 * responsible for its own I/O; this wrapper only enforces the
 * deadline and converts both outcomes into a SourceResult.
 */
export async function runWithTimeout<T>(
  opts: RunOpts,
  producer: (signal: AbortSignal) => Promise<T>,
): Promise<SourceResult<T>> {
  const t0 = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timeout after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  });

  try {
    const data = await Promise.race([producer(controller.signal), timeoutPromise]);
    return succeed(opts.source, data, Date.now() - t0, opts.stalenessSeconds ?? 0);
  } catch (err) {
    return failResult<T>(opts.source, err instanceof Error ? err.message : String(err), Date.now() - t0);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
