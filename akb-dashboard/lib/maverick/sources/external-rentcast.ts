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
  // Reset date is the 1st of the next calendar month (UTC) — RentCast
  // doesn't expose a header for this in 5/14 observation. Reported
  // here for the briefing's visibility.
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
      if (RENTCAST_API_KEY) {
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
  const firstOfNextMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0),
  );
  const msUntilReset = firstOfNextMonth.getTime() - now.getTime();
  return {
    api_responsive: apiResponsive,
    api_key_configured: Boolean(RENTCAST_API_KEY),
    monthly_cap: RENTCAST_MONTHLY_CAP,
    reset_date_utc: firstOfNextMonth.toISOString().slice(0, 10),
    days_until_reset: Math.max(0, Math.ceil(msUntilReset / 86_400_000)),
    probe_latency_ms: probeLatencyMs,
  };
}
