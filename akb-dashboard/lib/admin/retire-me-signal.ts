// Retire-me audit signal for draining backfill crons.
// 2026-06-11 ratification — when a backfill's eligible cohort empties,
// the cron still fires every */5 forever. Two backfills in the current
// roster (#14 url-backfill, #15 appraiser-backfill) are draining cohorts
// that will eventually hit zero. The previous failure mode was that
// nobody noticed and the slot kept burning lambda invocations until a
// human walked the cron list. This signal makes "I'm done, retire me"
// loud in the audit trail without self-modifying vercel.json — roster
// changes stay deliberate human commits (operator standing rule).
//
// Mechanism (KV-backed, in-memory fallback like the rentcast loop
// breaker):
//   - noteZeroRun(cronId): increment the consecutive-zero counter for
//     this cron. At >= ZERO_RUN_THRESHOLD consecutive zero runs, emit
//     ONE edge-triggered "retire_me" audit alert. The counter persists
//     so subsequent zero runs are silent (no alert spam).
//   - noteWorkRun(cronId): the cron found work this tick; clear the
//     counter and re-arm.
//
// Threshold is high enough to absorb a real lull (cohort temporarily
// empty because the cron drained the head of the queue faster than
// upstream refilled it) but low enough that a permanently-drained
// cohort lights up within ~half a day on a */5 schedule (288 ticks/day
// × ZERO_RUN_THRESHOLD/288 = ~10h before the alert lands at default 24).
//
// Fails OPEN on KV unavailability — a monitoring outage must not block
// the cron's actual work (same posture as the rentcast loop breaker).

import { audit } from "@/lib/audit-log";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const ZERO_RUN_THRESHOLD = (() => {
  const raw = Number(process.env.BACKFILL_RETIRE_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 24;
})();

const KV_PREFIX = "backfill:zero:";
const TTL_S = 60 * 60 * 24 * 7; // 7 days — outlives any real cohort lull

interface ZeroState {
  consecutive: number;
  firstZeroAt: string;
  alertedAt: string | null;
}

const memoryRing = new Map<string, ZeroState>();

async function readState(cronId: string): Promise<ZeroState | null> {
  if (kvConfigured()) {
    try {
      const v = await kvProd.get(`${KV_PREFIX}${cronId}`);
      if (typeof v === "string" && v.length > 0) return JSON.parse(v) as ZeroState;
    } catch {
      /* fall through */
    }
  }
  return memoryRing.get(cronId) ?? null;
}

async function writeState(cronId: string, state: ZeroState): Promise<void> {
  if (kvConfigured()) {
    try {
      await kvProd.setEx(`${KV_PREFIX}${cronId}`, JSON.stringify(state), TTL_S);
      return;
    } catch {
      /* fall through */
    }
  }
  memoryRing.set(cronId, state);
}

async function clearState(cronId: string): Promise<void> {
  if (kvConfigured()) {
    try {
      await kvProd.setEx(`${KV_PREFIX}${cronId}`, "", 1);
    } catch {
      /* best-effort */
    }
  }
  memoryRing.delete(cronId);
}

export interface RetireSignalResult {
  consecutiveZeroRuns: number;
  alerted: boolean;
  threshold: number;
}

/** Call when the backfill found NO eligible records this tick. */
export async function noteZeroRun(
  cronId: string,
  context: { cron_path: string; reason: string },
): Promise<RetireSignalResult> {
  const prev = (await readState(cronId)) ?? {
    consecutive: 0,
    firstZeroAt: new Date().toISOString(),
    alertedAt: null,
  };
  const wasAlerted = prev.alertedAt != null;
  const nextCount = prev.consecutive + 1;
  const nowAlerted = wasAlerted || nextCount >= ZERO_RUN_THRESHOLD;

  const next: ZeroState = {
    consecutive: nextCount,
    firstZeroAt: prev.firstZeroAt,
    alertedAt: nowAlerted ? prev.alertedAt ?? new Date().toISOString() : null,
  };

  // Edge-trigger: one alert at the crossing. Subsequent zero runs are
  // silent — alerts are for decisions, not noise.
  if (!wasAlerted && nowAlerted) {
    await audit({
      agent: "orchestrator",
      event: "retire_me",
      status: "uncertain",
      inputSummary: {
        cron_id: cronId,
        cron_path: context.cron_path,
        consecutive_zero_runs: nextCount,
        first_zero_at: prev.firstZeroAt,
        threshold: ZERO_RUN_THRESHOLD,
        reason: context.reason,
      },
      decision: "retire_me",
      error:
        `Backfill cron ${cronId} has found zero eligible records for ${nextCount} ` +
        `consecutive ticks (since ${prev.firstZeroAt}). The cohort is drained — ` +
        `roster cleanup needed (human commit to vercel.json).`,
    });
  }

  await writeState(cronId, next);
  return { consecutiveZeroRuns: nextCount, alerted: nowAlerted, threshold: ZERO_RUN_THRESHOLD };
}

/** Call when the backfill found work this tick — clears the counter. */
export async function noteWorkRun(cronId: string): Promise<void> {
  await clearState(cronId);
}

/** Test-only — clear the in-memory ring between cases. */
export function _resetMemoryRing(): void {
  memoryRing.clear();
}
