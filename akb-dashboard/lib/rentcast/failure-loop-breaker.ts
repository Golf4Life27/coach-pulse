// RentCast failure-loop breaker (operator 2026-06-11 morning P0).
// @agent: appraiser / scout
//
// THE INCIDENT: a */10 single-record cron (resource-bexar-taxes on
// recG4GNM2sa0ZYj7p) called RentCast's properties endpoint on an address
// that wasn't in RentCast's index, returning HTTP 404 every tick. 6+
// consecutive billed 404s in an hour with no breaker in front of the call
// — exactly the loop-on-dead-call shape the Firecrawl spend breaker
// (lib/crawler/firecrawl-circuit-breaker.ts) was built to prevent for the
// other paid surface.
//
// THE RULE (same class as the Firecrawl one, different shape): no paid
// API call retries forever on a stable failure. We track recent failures
// by CALL SHAPE (endpoint + a hash of the parameters that change the
// answer — address fields, recordId — NOT the API key). After N
// consecutive failures of the same shape, the breaker trips and the next
// call returns a short-circuit failure instead of spending again, plus
// emits one alert audit. Successes clear the counter.
//
// KV-backed when configured; in-memory fallback otherwise (per-lambda,
// which is enough to catch a within-instance loop). Fails OPEN on KV
// errors — a monitoring outage must not block legitimate calls.

import { audit } from "@/lib/audit-log";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

/** Consecutive failures of the same call shape before the breaker trips.
 *  Three is enough to absorb a transient network/origin blip without
 *  letting a cron loop bill more than ~30 minutes of spend (at every-
 *  10-min cron cadence the fourth call within ~30 min trips). Env-tunable. */
export const RENTCAST_LOOP_TRIP_AFTER = (() => {
  const raw = Number(process.env.RENTCAST_LOOP_TRIP_AFTER);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
})();

/** TTL on the failure-counter key. Long enough that a slow loop can't
 *  reset by simple time-passing, short enough that a real recovery
 *  (address now indexed; API back up) heals without manual reset. */
const COUNTER_TTL_S = 60 * 60 * 6; // 6h

const KV_PREFIX = "rc:loop:";

interface CounterState {
  count: number;
  lastStatus: number;
  lastAt: string;
  alertedAt: string | null;
}

// In-memory fallback for environments without KV. Per-lambda lifetime,
// which is enough to catch a fast loop inside a single warm instance.
const memoryRing = new Map<string, CounterState>();

/** Stable call-shape key. Endpoint + a hash of the answer-relevant
 *  inputs (address/zip + recordId if known). API keys, request IDs,
 *  and other per-call noise are excluded so a real loop converges to
 *  the same key across ticks. */
export function callShapeKey(
  endpoint: string,
  params: {
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    recordId?: string | null;
  },
): string {
  const a = (params.address ?? "").trim().toLowerCase();
  const c = (params.city ?? "").trim().toLowerCase();
  const s = (params.state ?? "").trim().toLowerCase();
  const z = (params.zip ?? "").trim().toLowerCase();
  const r = (params.recordId ?? "").trim();
  return `${endpoint}|${r}|${a}|${c}|${s}|${z}`;
}

async function readCounter(key: string): Promise<CounterState | null> {
  if (kvConfigured()) {
    try {
      const v = await kvProd.get(`${KV_PREFIX}${key}`);
      if (typeof v === "string" && v.length > 0) {
        return JSON.parse(v) as CounterState;
      }
    } catch {
      /* fall through to memory */
    }
  }
  return memoryRing.get(key) ?? null;
}

async function writeCounter(key: string, state: CounterState): Promise<void> {
  if (kvConfigured()) {
    try {
      await kvProd.setEx(`${KV_PREFIX}${key}`, JSON.stringify(state), COUNTER_TTL_S);
      return;
    } catch {
      /* fall through to memory */
    }
  }
  memoryRing.set(key, state);
}

async function clearCounter(key: string): Promise<void> {
  if (kvConfigured()) {
    try {
      // setEx with a tiny TTL is a soft delete that survives Upstash's
      // lack of a DEL helper here. Memory ring also cleared.
      await kvProd.setEx(`${KV_PREFIX}${key}`, "", 1);
    } catch {
      /* best-effort */
    }
  }
  memoryRing.delete(key);
}

export interface BreakerState {
  /** True when the breaker is TRIPPED — caller MUST skip the paid call. */
  tripped: boolean;
  /** Consecutive failures observed so far for this shape. */
  count: number;
  /** The HTTP status that's been looping (e.g. 404). null if no prior fail. */
  lastStatus: number | null;
  /** Threshold for trip. */
  tripAfter: number;
  /** The call-shape key, so callers can emit it in audit/alert. */
  key: string;
}

/** Read-only check — call this BEFORE the paid fetch to decide whether
 *  to short-circuit. Always returns tripped=false when no counter exists. */
export async function checkLoopBreaker(
  endpoint: string,
  params: Parameters<typeof callShapeKey>[1],
): Promise<BreakerState> {
  const key = callShapeKey(endpoint, params);
  const state = await readCounter(key);
  if (!state) {
    return { tripped: false, count: 0, lastStatus: null, tripAfter: RENTCAST_LOOP_TRIP_AFTER, key };
  }
  return {
    tripped: state.count >= RENTCAST_LOOP_TRIP_AFTER,
    count: state.count,
    lastStatus: state.lastStatus,
    tripAfter: RENTCAST_LOOP_TRIP_AFTER,
    key,
  };
}

/** Record an HTTP outcome. Success (2xx) clears the counter. Anything
 *  else increments it and, at the moment of crossing the trip threshold,
 *  emits one alert audit ("rentcast_loop_tripped") so the surface that
 *  surfaces audit entries (Pulse, the daily briefing, the spend dashboard)
 *  catches the trip — no silent breaker. */
export async function recordCallOutcome(
  endpoint: string,
  params: Parameters<typeof callShapeKey>[1],
  httpStatus: number,
): Promise<BreakerState> {
  const key = callShapeKey(endpoint, params);

  // Success — clear and short-circuit out.
  if (httpStatus >= 200 && httpStatus < 300) {
    await clearCounter(key);
    return { tripped: false, count: 0, lastStatus: httpStatus, tripAfter: RENTCAST_LOOP_TRIP_AFTER, key };
  }

  const prev = (await readCounter(key)) ?? {
    count: 0,
    lastStatus: 0,
    lastAt: new Date(0).toISOString(),
    alertedAt: null,
  };
  const nextCount = prev.count + 1;
  const wasTripped = prev.count >= RENTCAST_LOOP_TRIP_AFTER;
  const nowTripped = nextCount >= RENTCAST_LOOP_TRIP_AFTER;

  const next: CounterState = {
    count: nextCount,
    lastStatus: httpStatus,
    lastAt: new Date().toISOString(),
    alertedAt: prev.alertedAt,
  };

  // Edge-trigger the alert: one audit at the moment the breaker trips.
  // Not on every subsequent skip — alerts are for decisions, not noise.
  if (!wasTripped && nowTripped) {
    next.alertedAt = next.lastAt;
    await audit({
      agent: "appraiser",
      event: "rentcast_loop_tripped",
      status: "confirmed_failure",
      inputSummary: {
        endpoint,
        recordId: params.recordId ?? null,
        address: params.address ?? null,
        zip: params.zip ?? null,
        http_status: httpStatus,
        consecutive_failures: nextCount,
        trip_after: RENTCAST_LOOP_TRIP_AFTER,
      },
      error: `RentCast loop breaker tripped after ${nextCount} consecutive HTTP ${httpStatus} on the same call shape — subsequent calls short-circuit until a success clears the counter.`,
    });
  }

  await writeCounter(key, next);
  return { tripped: nowTripped, count: nextCount, lastStatus: httpStatus, tripAfter: RENTCAST_LOOP_TRIP_AFTER, key };
}

/** Record a thrown error (network blip, DNS fail). Counted as a failure
 *  with synthetic status -1 so the breaker trips on prolonged network
 *  outages too, not just stable 4xx/5xx. */
export async function recordCallError(
  endpoint: string,
  params: Parameters<typeof callShapeKey>[1],
): Promise<BreakerState> {
  return recordCallOutcome(endpoint, params, -1);
}

/** Test-only: clear the in-memory ring between cases. */
export function _resetMemoryRing(): void {
  memoryRing.clear();
}
