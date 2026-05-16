// Maverick source — Quo (OpenPhone) state.
// @agent: maverick
//
// API responsiveness + last-known activity timestamps from the Quo
// inbox. v1 surfaces what's queryable via the existing
// lib/quo.getMessagesForParticipant pattern, scoped to "recent
// activity from any participant on our Quo number."
//
// Budget: 3s. Two parallel calls — a minimal health probe + an
// activity-window query. Probe outcome drives `api_responsive`;
// activity outcome drives the activity stats. Separating them
// prevents the v1.2 finding #6 false-negative where 0 messages in
// the activity window collapsed to "Quo is dark" even when the API
// itself was healthy.
//
// Spec v1.1 §5 Step 1; finding #6 fix per Checklist Phase 11.1.

import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";

const DEFAULT_TIMEOUT_MS = 3_000;

const QUO_API_KEY = process.env.QUO_API_KEY;
const QUO_PHONE_ID = process.env.QUO_PHONE_ID || "PNLosBI6fh";
const QUO_BASE_URL = "https://api.openphone.com/v1/messages";

export interface QuoState {
  api_responsive: boolean;
  api_key_configured: boolean;
  // Most recent outbound/inbound across all participants. Used by
  // briefing to surface "Quo last sent N minutes ago" / "last
  // inbound N minutes ago" — coarse health signal.
  most_recent_outbound_at: string | null;
  most_recent_inbound_at: string | null;
  // Total messages in the 24h window — a basic activity check.
  messages_last_24h: number;
}

export async function fetchExternalQuoState(
  opts: FetchOpts = {},
): Promise<SourceResult<QuoState>> {
  return runWithTimeout(
    { source: "external_quo", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async (signal) => {
      if (!QUO_API_KEY) {
        return {
          api_responsive: false,
          api_key_configured: false,
          most_recent_outbound_at: null,
          most_recent_inbound_at: null,
          messages_last_24h: 0,
        };
      }
      const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60_000);

      // Run probe + activity calls in parallel. Probe shape is
      // intentionally minimal: just phoneNumberId + maxResults=1.
      // Activity shape uses the same endpoint with a createdAfter
      // filter for the 24h window. If a future Quo schema change
      // breaks one shape but not the other, we want the briefing to
      // distinguish "API alive, schema drift on activity query"
      // from "API down."
      const [probe, activity] = await Promise.allSettled([
        probeQuoHealth(signal),
        fetchQuoActivity(since, signal),
      ]);

      const apiResponsive =
        probe.status === "fulfilled" && probe.value === true;
      const messages =
        activity.status === "fulfilled" ? activity.value : null;

      if (messages === null) {
        // Probe may have succeeded; activity may not have. Surface
        // whatever we know without collapsing to false-negative.
        return {
          api_responsive: apiResponsive,
          api_key_configured: true,
          most_recent_outbound_at: null,
          most_recent_inbound_at: null,
          messages_last_24h: 0,
        };
      }
      // Activity succeeded — compose stats, but only mark
      // api_responsive=true if the probe also confirmed.
      const summarized = summarizeMessages(messages);
      return { ...summarized, api_responsive: apiResponsive };
    },
  );
}

/**
 * Minimal health probe — phoneNumberId + maxResults=1. Returns true
 * on any 2xx, false otherwise. No body parsing — we only care
 * whether the endpoint responds cleanly.
 */
async function probeQuoHealth(signal: AbortSignal): Promise<boolean> {
  if (!QUO_API_KEY) return false;
  const url = new URL(QUO_BASE_URL);
  url.searchParams.set("phoneNumberId", QUO_PHONE_ID);
  url.searchParams.set("maxResults", "1");
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: QUO_API_KEY,
      "Content-Type": "application/json",
    },
    signal,
    cache: "no-store",
  });
  return res.ok;
}

/**
 * Activity-window query. Returns the raw message array or throws on
 * non-2xx. Caller wraps in allSettled so a 4xx from a schema drift
 * doesn't take down the briefing.
 */
async function fetchQuoActivity(
  since: Date,
  signal: AbortSignal,
): Promise<Array<{ direction?: string; createdAt?: string }>> {
  const url = new URL(QUO_BASE_URL);
  url.searchParams.set("phoneNumberId", QUO_PHONE_ID);
  url.searchParams.set("createdAfter", since.toISOString());
  url.searchParams.set("maxResults", "50");
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: QUO_API_KEY as string,
      "Content-Type": "application/json",
    },
    signal,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`activity query non-2xx: ${res.status}`);
  }
  const body = (await res.json()) as {
    data?: Array<{ direction?: string; createdAt?: string }>;
  };
  return body.data ?? [];
}

/**
 * Pure summarizer — tests provide synthetic message arrays.
 * Always returns api_responsive: true since by construction the
 * caller only invokes this when the activity call succeeded. The
 * fetch wrapper may override api_responsive based on probe outcome.
 */
export function summarizeMessages(
  messages: Array<{ direction?: string; createdAt?: string }>,
): QuoState {
  let mostRecentOutbound: string | null = null;
  let mostRecentInbound: string | null = null;
  for (const m of messages) {
    if (!m.createdAt) continue;
    if (m.direction === "outgoing" || m.direction === "outbound") {
      if (!mostRecentOutbound || m.createdAt > mostRecentOutbound) {
        mostRecentOutbound = m.createdAt;
      }
    } else if (m.direction === "incoming" || m.direction === "inbound") {
      if (!mostRecentInbound || m.createdAt > mostRecentInbound) {
        mostRecentInbound = m.createdAt;
      }
    }
  }
  return {
    api_responsive: true,
    api_key_configured: true,
    most_recent_outbound_at: mostRecentOutbound,
    most_recent_inbound_at: mostRecentInbound,
    messages_last_24h: messages.length,
  };
}
