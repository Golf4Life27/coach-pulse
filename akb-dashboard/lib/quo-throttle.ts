// Phase 2.8 / Q.6 — Quo send throttle.
//
// Practical 15-sends-per-hour cap. Reads the audit-log (KV-backed)
// for recent quo:send_attempt events, counts within the rolling
// window, and throws QuoThrottleError when the cap is reached.
// Callers should catch and either skip the send or queue it for the
// next interval.
//
// Why a throttle helper instead of in-line in sendMessageWithId:
//   - lib/quo.ts is pure HTTP wrapper; throttle adds a KV dep.
//   - Tests for sendMessage stay simple (no audit-log stubbing
//     required for the unrelated send path).
//   - Operator can call assertThrottleHeadroom() defensively from
//     any caller that batches sends (cron paths, dispo blast, etc.).
//
// The throttle is observability + soft enforcement — Quo's carrier-
// side throttle is the hard backstop. This catches us before we hit
// that and waste calls.

import { readRecentFromKv } from "./audit-log";

const DEFAULT_LIMIT_PER_HOUR = 15;

export class QuoThrottleError extends Error {
  readonly limit: number;
  readonly sends_in_window: number;
  readonly window_ms: number;
  constructor(opts: { limit: number; sends_in_window: number; window_ms: number }) {
    super(
      `Quo throttle reached: ${opts.sends_in_window}/${opts.limit} sends in last ${Math.round(opts.window_ms / 60_000)} minutes`,
    );
    this.name = "QuoThrottleError";
    this.limit = opts.limit;
    this.sends_in_window = opts.sends_in_window;
    this.window_ms = opts.window_ms;
  }
}

function readLimit(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): number {
  const raw = env.QUO_THROTTLE_PER_HOUR;
  if (!raw) return DEFAULT_LIMIT_PER_HOUR;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT_PER_HOUR;
  return Math.floor(n);
}

export interface ThrottleStatus {
  limit: number;
  sends_in_window: number;
  window_ms: number;
  at_limit: boolean;
  remaining: number;
}

/** Pure: classify a snapshot of recent audit entries against the
 *  configured throttle. Exported for testing without KV. */
export function classifyThrottle(opts: {
  recent_send_count: number;
  limit?: number;
  window_ms?: number;
}): ThrottleStatus {
  const limit = opts.limit ?? DEFAULT_LIMIT_PER_HOUR;
  const window_ms = opts.window_ms ?? 3_600_000;
  const sends_in_window = opts.recent_send_count;
  return {
    limit,
    sends_in_window,
    window_ms,
    at_limit: sends_in_window >= limit,
    remaining: Math.max(0, limit - sends_in_window),
  };
}

/** Reads recent KV audit events + counts quo.send_attempt within
 *  window. Pure-helper-with-I/O — call from any send-initiating
 *  surface. */
export async function getQuoThrottleStatus(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  now: Date = new Date(),
): Promise<ThrottleStatus> {
  const limit = readLimit(env);
  const events = await readRecentFromKv(200);
  const cutoff = now.getTime() - 3_600_000;
  let count = 0;
  for (const e of events) {
    if (e.agent !== "quo" || e.event !== "send_attempt") continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    count++;
  }
  return classifyThrottle({ recent_send_count: count, limit });
}

/** Throws QuoThrottleError when at the limit. Callers wrap their
 *  send fan-out with: `await assertThrottleHeadroom()` before
 *  invoking sendMessageWithId. */
export async function assertThrottleHeadroom(): Promise<void> {
  const status = await getQuoThrottleStatus();
  if (status.at_limit) {
    throw new QuoThrottleError({
      limit: status.limit,
      sends_in_window: status.sends_in_window,
      window_ms: status.window_ms,
    });
  }
}
