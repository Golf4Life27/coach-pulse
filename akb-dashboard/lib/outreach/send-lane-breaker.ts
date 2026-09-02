// Send-lane 402 breaker (2026-09-02, the prepaid-credits outage).
//
// THE INCIDENT: Quo prepaid credits hit zero at ~13:05Z. Every outreach and
// bump slot for the next nine hours still processed 20 records each — ran
// the Firecrawl pre-send probe (~40 credits/run), called Quo, got HTTP 402,
// swallowed it per record (errors:20, first_touch_sent:0), and moved to the
// next record. ~360 probe credits burned to send nothing, and the Pulse
// pager that should have told the operator died on the same 402.
//
// THE RULE: a 402 from Quo is a STABLE failure that heals only by an operator
// top-up. After the first one, the lane trips: the current run stops
// processing, and later runs skip the loop entirely until the TTL expires
// (short, so a top-up is picked up within one slot). KV-backed when
// configured, in-memory fallback otherwise. Fails OPEN on KV errors — a
// monitoring outage must never block legitimate sends.

import { audit } from "@/lib/audit-log";
import { kvConfigured, kvProd, type KvClient } from "@/lib/maverick/oauth/kv";

export const SEND_LANE_BREAKER_KEY = "send_lane:quo_402";

/** How long the lane stays tripped after a 402. Short on purpose: the
 *  operator tops up and the next slot should just work. Env-tunable. */
export const SEND_LANE_402_TTL_S = (() => {
  const raw = Number(process.env.SEND_LANE_402_TTL_S);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20 * 60;
})();

export type SendLane = "h2_outreach" | "h2_bump" | "creative_outreach" | "session" | "pulse_page";

export interface SendLaneBreakerState {
  tripped: boolean;
  tripped_at: string | null;
}

/** True when the error is Quo telling us the account cannot pay for the
 *  message. Reads the structured status first, the message string second
 *  (older call sites still throw plain Errors). */
export function isQuoCreditsExhausted(err: unknown): boolean {
  if (!err) return false;
  const status = (err as { httpStatus?: unknown }).httpStatus;
  if (status === 402) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /Quo send error 402\b/.test(msg) || /not have enough prepaid credits/i.test(msg);
}

let memoryTrip: { at: string; expiresMs: number } | null = null;

function memoryState(nowMs: number): SendLaneBreakerState {
  if (memoryTrip && memoryTrip.expiresMs > nowMs) return { tripped: true, tripped_at: memoryTrip.at };
  memoryTrip = null;
  return { tripped: false, tripped_at: null };
}

/** Is the lane currently tripped? */
export async function checkSendLaneBreaker(
  kv: KvClient | null = kvConfigured() ? kvProd : null,
  now: Date = new Date(),
): Promise<SendLaneBreakerState> {
  if (!kv) return memoryState(now.getTime());
  try {
    const v = await kv.get(SEND_LANE_BREAKER_KEY);
    return v ? { tripped: true, tripped_at: v } : { tripped: false, tripped_at: null };
  } catch {
    return memoryState(now.getTime()); // fail open
  }
}

/** Trip the lane. Emits ONE audit row per trip so the outage is queryable
 *  (`quo_credits_exhausted`) and the Machine Health screen can show it. */
export async function tripSendLaneBreaker(
  lane: SendLane,
  err: unknown,
  kv: KvClient | null = kvConfigured() ? kvProd : null,
  auditFn: typeof audit = audit,
  now: Date = new Date(),
): Promise<void> {
  const at = now.toISOString();
  memoryTrip = { at, expiresMs: now.getTime() + SEND_LANE_402_TTL_S * 1000 };
  if (kv) {
    try {
      await kv.setEx(SEND_LANE_BREAKER_KEY, at, SEND_LANE_402_TTL_S);
    } catch {
      /* memory trip already recorded */
    }
  }
  await auditFn({
    agent: "crier",
    event: "quo_credits_exhausted",
    status: "confirmed_failure",
    inputSummary: { lane, ttl_s: SEND_LANE_402_TTL_S },
    outputSummary: {
      tripped_at: at,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      fix: "Add prepaid credits in Quo billing (enable auto-recharge). The lane retries automatically when the TTL expires.",
    },
    decision: "lane_tripped",
  }).catch(() => {});
}

/** Clear the trip (a successful send proves credits exist again). */
export async function clearSendLaneBreaker(kv: KvClient | null = kvConfigured() ? kvProd : null): Promise<void> {
  memoryTrip = null;
  if (kv) await kv.del(SEND_LANE_BREAKER_KEY).catch(() => {});
}

/** Test seam. */
export function _resetSendLaneBreakerMemory(): void {
  memoryTrip = null;
}
