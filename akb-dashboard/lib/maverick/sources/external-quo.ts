// Maverick source — Quo (OpenPhone) state.
// @agent: maverick
//
// API responsiveness + last-known activity timestamps from the Quo
// inbox. v1 surfaces what's queryable via the existing
// lib/quo.getMessagesForParticipant pattern, scoped to "recent
// activity from any participant on our Quo number."
//
// Budget: 3s. One messages list call.
// Spec v1.1 §5 Step 1.

import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";

const DEFAULT_TIMEOUT_MS = 3_000;

const QUO_API_KEY = process.env.QUO_API_KEY;
const QUO_PHONE_ID = process.env.QUO_PHONE_ID || "PNLosBI6fh";

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
      const url = new URL("https://api.openphone.com/v1/messages");
      url.searchParams.set("phoneNumberId", QUO_PHONE_ID);
      url.searchParams.set("createdAfter", since.toISOString());
      url.searchParams.set("maxResults", "50");

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: QUO_API_KEY,
          "Content-Type": "application/json",
        },
        signal,
        cache: "no-store",
      });

      if (!res.ok) {
        // Treat any non-2xx as "not responsive" but don't throw —
        // the briefing should still render with this signal as a
        // health flag, not a hard error.
        return {
          api_responsive: false,
          api_key_configured: true,
          most_recent_outbound_at: null,
          most_recent_inbound_at: null,
          messages_last_24h: 0,
        };
      }

      const body = (await res.json()) as {
        data?: Array<{ direction?: string; createdAt?: string }>;
      };
      return summarizeMessages(body.data ?? []);
    },
  );
}

/**
 * Pure summarizer — tests provide synthetic message arrays.
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
