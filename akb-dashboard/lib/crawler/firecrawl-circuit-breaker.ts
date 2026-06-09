// Firecrawl spend circuit-breaker (operator 2026-06-09).
// @agent: scout
//
// THE INCIDENT: the */10 intake cron re-verified the full 54-ZIP registry
// across unpriceable TX markets as the 24h freshness cycle came due and
// quietly drained ~15,700 Firecrawl credits in ~16h before anyone noticed.
//
// THE RULE: no background process touches a paid API without a brake that
// HALTS it before it can drain the balance. This tracks Firecrawl credits
// spent per rolling hour (KV) and hard-stops + fires a Pulse alert once
// spend crosses a cap. The per-run scrape budget bounds a single tick; this
// bounds spend ACROSS ticks so a repeating per-tick loop can't bleed out.
//
// Two enforcement points in the caller:
//   1. Pre-dispatch: checkFirecrawlBreaker() — if already over cap this
//      hour, skip the verify phase entirely (alert + audit, no spend).
//   2. In-run: stop dispatching once spent_this_hour + credits_this_run
//      reaches the cap, so a single run can't blow past it either.
//
// Fails OPEN on KV unavailability (the per-run budget still applies) — a
// monitoring outage must not halt the pipeline, but it's logged.

import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

/** Hard cap on Firecrawl credits spent per rolling hour. Sane default:
 *  scoped intake (priceable ZIPs only) spends low hundreds/hr at most, so
 *  800 is generous headroom yet trips fast on a full-registry runaway —
 *  halting before it can drain more than ~6% of a 14k balance. Env-tunable. */
export const FIRECRAWL_HOURLY_CREDIT_CAP = (() => {
  const raw = Number(process.env.FIRECRAWL_HOURLY_CREDIT_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 800;
})();

const KV_PREFIX = "fc:spend:h:";
const BUCKET_TTL_S = 7200; // 2h — covers the current + previous hour window

function hourIndex(now: Date): number {
  return Math.floor(now.getTime() / 3_600_000);
}

export interface BreakerVerdict {
  tripped: boolean;
  /** Credits spent in the current + previous hour bucket (rolling ~1–2h). */
  spentRecent: number;
  cap: number;
  headroom: number;
}

/** Pure: the breaker verdict for a known recent-spend figure. Tested. */
export function evaluateBreaker(spentRecent: number, cap: number = FIRECRAWL_HOURLY_CREDIT_CAP): BreakerVerdict {
  const spent = Number.isFinite(spentRecent) && spentRecent > 0 ? spentRecent : 0;
  return { tripped: spent >= cap, spentRecent: spent, cap, headroom: Math.max(0, cap - spent) };
}

/** Credits spent in the current + previous hour bucket (rolling window).
 *  0 when KV is unconfigured (breaker tracking disabled — fail open). */
export async function firecrawlSpentRecent(now: Date = new Date()): Promise<number> {
  if (!kvConfigured()) return 0;
  const cur = hourIndex(now);
  let total = 0;
  for (const idx of [cur, cur - 1]) {
    try {
      const v = await kvProd.get(`${KV_PREFIX}${idx}`);
      if (v) total += Number(v) || 0;
    } catch {
      /* best-effort; a read miss must not block */
    }
  }
  return total;
}

/** Record credits spent this run into the current hour bucket (get+add+setEx).
 *  Not atomic, but a slight undercount is acceptable for a safety brake — the
 *  in-run cap is exact within a run, this bounds the cross-run total. */
export async function recordFirecrawlSpend(credits: number, now: Date = new Date()): Promise<void> {
  if (!kvConfigured() || !(credits > 0)) return;
  const key = `${KV_PREFIX}${hourIndex(now)}`;
  try {
    const prev = Number((await kvProd.get(key)) ?? "0") || 0;
    await kvProd.setEx(key, String(prev + Math.round(credits)), BUCKET_TTL_S);
  } catch {
    /* best-effort */
  }
}

/** Read the rolling-hour spend and return the breaker verdict. */
export async function checkFirecrawlBreaker(now: Date = new Date()): Promise<BreakerVerdict> {
  return evaluateBreaker(await firecrawlSpentRecent(now), FIRECRAWL_HOURLY_CREDIT_CAP);
}
