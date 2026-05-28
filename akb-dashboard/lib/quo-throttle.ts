// Phase 2.8 / Q.6 — Quo send throttle. WIRED into batch dispatch paths
// per Brief 4a follow-up (Checklist 24.7): h2-outreach, outreach-fire,
// buyers/fire-blast, maverick sms-escalation. Interactive single-send
// paths (jarvis-send, deal-action, dd-volley-send, zip-approval/notify)
// are intentionally NOT gated — blocking a human-triggered SMS is worse
// than letting it through — but their sends still count toward the
// rolling-hour window via the audit entry written by lib/quo.ts
// sendMessageWithId. See AGENTS.md → Outbound SMS volume ceiling.
//
// Practical 20-sends-per-hour cap (DEFAULT_LIMIT_PER_HOUR), env-tunable
// via QUO_THROTTLE_LIMIT_PER_HOUR. Reads the audit-log (KV-backed) for
// recent quo:send_attempt events, counts within the rolling window, and
// throws QuoThrottleError when the cap is reached. Callers in batch
// loops should prefer tryAcquireThrottle (returns ok|skip and audits
// the rate_limit_skipped reason) over the throw form.
//
// Why a throttle helper instead of in-line in sendMessageWithId:
//   - lib/quo.ts stays a thin wrapper; the KV throttle CHECK adds a
//     dep that callers should opt into. (The audit-log WRITE in quo.ts
//     is unavoidable — it's how this throttle counts at all.)
//   - Tests for sendMessage stay simple (no audit-log stubbing
//     required for the unrelated send path).
//
// The throttle is observability + soft enforcement — Quo/10DLC's
// carrier-side provisioned throughput is the hard backstop. This catches
// us before we hit that and waste calls. Ramp coordination: this cap
// MUST rise in lockstep with H2_DAILY_LIMIT_PER_RUN — week 1 (12/run)
// fits under 20; week 2 (25/run) needs QUO_THROTTLE_LIMIT_PER_HOUR
// raised to ≥30 BEFORE H2_DAILY_LIMIT_PER_RUN goes to 25.

import { audit, readRecentFromKv } from "./audit-log";

const DEFAULT_LIMIT_PER_HOUR = 20;

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
  const raw = env.QUO_THROTTLE_LIMIT_PER_HOUR;
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

/** Non-throwing throttle gate for batch-loop callers. Returns
 *  {ok:true} when there's headroom; on skip, writes a
 *  `rate_limit_skipped` audit entry (so we can observe how often the
 *  backstop fires) and returns {ok:false, status}. Caller is expected
 *  to break out of the batch loop on skip — every subsequent send in
 *  the same hour will also skip. */
export async function tryAcquireThrottle(
  context: { listing_id?: string; caller?: string } = {},
): Promise<{ ok: true } | { ok: false; status: ThrottleStatus }> {
  const status = await getQuoThrottleStatus();
  if (!status.at_limit) return { ok: true };
  await audit({
    agent: "quo",
    event: "send_skipped",
    status: "confirmed_failure",
    decision: "rate_limit_skipped",
    inputSummary: {
      caller: context.caller,
      limit: status.limit,
      sends_in_window: status.sends_in_window,
      window_ms: status.window_ms,
    },
    recordId: context.listing_id,
  });
  return { ok: false, status };
}
