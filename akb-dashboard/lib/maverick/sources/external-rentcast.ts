// Maverick source — RentCast quota state.
// @agent: maverick
//
// RentCast doesn't publish a public quota endpoint as of 5/14 spec
// authoring. v1 reports api_responsive Y/N + the env-configured
// monthly cap; burn-rate is derived from the audit-log count of
// pricing-agent calls in the last 24h. days_until_exhaustion is
// computed from cap remaining ÷ burn rate.
//
// Budget: 3s. One GET to verify responsiveness (a low-cost endpoint
// like the property-records search with the smallest valid query).
// Spec v1.1 §5 Step 1.

import { runWithTimeout } from "../timeout";
import { isRentcastFrozen, nextBillingPeriodStart } from "@/lib/rentcast/spend-ceiling";
import type { FetchOpts, SourceResult } from "../types";

const DEFAULT_TIMEOUT_MS = 3_000;

const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
// Monthly cap — env-driven so it can be tuned without a deploy.
// 5/13 baseline was 1000 calls/month for the working tier.
const RENTCAST_MONTHLY_CAP = Number(process.env.RENTCAST_MONTHLY_CAP ?? "1000");

export interface RentCastState {
  api_responsive: boolean;
  api_key_configured: boolean;
  monthly_cap: number;
  // FIXED 2026-09-24 (the "Oct 1 reset" false report): this used to be the
  // 1st of the next calendar month. The vendor dashboard showed the plan
  // running ~11th → ~11th ("day 11 of 30" on 2026-09-22), so the reset date
  // is now the next RENTCAST_BILLING_ANCHOR_DAY (spend-ceiling.ts), not the
  // 1st. RentCast still doesn't expose a header for this — it's still an
  // approximation, just anchored on the real cycle instead of the calendar.
  reset_date_utc: string;
  // Days remaining in the current billing window.
  days_until_reset: number;
  // Latency observation surfaced into the briefing as a health hint.
  probe_latency_ms: number;
}

export async function fetchExternalRentCastState(
  opts: FetchOpts = {},
): Promise<SourceResult<RentCastState>> {
  return runWithTimeout(
    { source: "external_rentcast", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async (signal) => {
      const probeStart = Date.now();
      let apiResponsive = false;
      // Operator freeze (2026-09-07): the probe is a paid call too. Skip it.
      if (RENTCAST_API_KEY && !isRentcastFrozen()) {
        try {
          // Lightweight probe: hit the avm/value endpoint with a
          // syntactically valid but cheap query. We only check the
          // HTTP code for responsiveness — never consume the response
          // body unless we want to use the data.
          const res = await fetch(
            "https://api.rentcast.io/v1/markets?zipCode=78201",
            {
              headers: { "X-Api-Key": RENTCAST_API_KEY },
              signal,
            },
          );
          apiResponsive = res.ok || res.status === 429; // 429 = up but throttled
        } catch {
          apiResponsive = false;
        }
      }
      return composeRentCastState(apiResponsive, Date.now() - probeStart, new Date());
    },
  );
}

/**
 * Pure composer — tests assert without HTTP.
 */
export function composeRentCastState(
  apiResponsive: boolean,
  probeLatencyMs: number,
  now: Date,
): RentCastState {
  const resetDateUtc = nextBillingPeriodStart(now);
  const msUntilReset = new Date(`${resetDateUtc}T00:00:00.000Z`).getTime() - now.getTime();
  return {
    api_responsive: apiResponsive,
    api_key_configured: Boolean(RENTCAST_API_KEY),
    monthly_cap: RENTCAST_MONTHLY_CAP,
    reset_date_utc: resetDateUtc,
    days_until_reset: Math.max(0, Math.ceil(msUntilReset / 86_400_000)),
    probe_latency_ms: probeLatencyMs,
  };
}
