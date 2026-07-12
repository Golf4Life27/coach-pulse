// Maverick source — Quo (OpenPhone) state.
// @agent: maverick
//
// API responsiveness + last-known activity from the Quo line.
//
// 2026-07-12 PROBE FIX (spine rec17krmeSuttdyNy companion): the old probe
// and activity query hit GET /v1/messages with phoneNumberId only — but
// OpenPhone REQUIRES `participants` on that endpoint (see the working
// production shape in lib/quo.ts getMessagesForParticipant). Both calls
// 400'd on every run, so the source permanently reported
// api_responsive=false / 0 messages while the line demonstrably carried
// ~55 messages in 48h. The probe was structurally incapable of reporting
// healthy.
//
// Now: health = /v1/phone-numbers (simplest authenticated endpoint), with
// a fallback to the production-proven messages+participants shape (an
// inert participant is a valid query and returns 2xx). Activity =
// /v1/conversations for the line, counting conversations with
// lastActivityAt inside the window — no participants requirement. Every
// call degrades independently; activity failure never collapses
// api_responsive to false (v1.2 finding #6 held).
//
// Budget: 3s. Spec v1.1 §5 Step 1.

import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";

const DEFAULT_TIMEOUT_MS = 3_000;

const QUO_API_KEY = process.env.QUO_API_KEY;
const QUO_PHONE_ID = process.env.QUO_PHONE_ID || "PNLosBI6fh";
const QUO_API_ROOT = "https://api.openphone.com/v1";
// Inert-but-valid E.164 for the fallback probe — the query shape matches
// lib/quo.ts exactly; an unknown participant returns 2xx with empty data.
const PROBE_PARTICIPANT = "+15005550006";

export interface QuoState {
  api_responsive: boolean;
  api_key_configured: boolean;
  // Most recent activity on the line (from the conversations endpoint —
  // direction is not exposed there, so both carry the same value when
  // known). Coarse health signal only.
  most_recent_outbound_at: string | null;
  most_recent_inbound_at: string | null;
  /** Conversations with activity inside the window (24h default) — the
   *  basic "is the line alive" count. NOT a per-message count: the
   *  messages endpoint requires participants and cannot enumerate the
   *  whole line. */
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

      const [probe, activity] = await Promise.allSettled([
        probeQuoHealth(signal),
        fetchQuoConversationActivity(since, signal),
      ]);

      const apiResponsive = probe.status === "fulfilled" && probe.value === true;
      if (activity.status !== "fulfilled") {
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
      return { ...summarizeConversations(activity.value, since), api_responsive: apiResponsive };
    },
  );
}

/**
 * Health probe. Primary: GET /v1/phone-numbers (simplest authenticated
 * endpoint — no required params). Fallback: the exact production message
 * query shape from lib/quo.ts (phoneNumberId + participants + maxResults),
 * which is proven to 2xx against this workspace. Responsive when EITHER
 * returns 2xx — a wrong guess about one endpoint's shape can never again
 * pin the line at "down".
 */
async function probeQuoHealth(signal: AbortSignal): Promise<boolean> {
  if (!QUO_API_KEY) return false;
  const headers = { Authorization: QUO_API_KEY, "Content-Type": "application/json" };

  try {
    const res = await fetch(`${QUO_API_ROOT}/phone-numbers`, { headers, signal, cache: "no-store" });
    if (res.ok) return true;
  } catch {
    /* fall through to the proven shape */
  }

  const url = new URL(`${QUO_API_ROOT}/messages`);
  url.searchParams.set("phoneNumberId", QUO_PHONE_ID);
  url.searchParams.append("participants", PROBE_PARTICIPANT);
  url.searchParams.set("maxResults", "1");
  const res = await fetch(url.toString(), { headers, signal, cache: "no-store" });
  return res.ok;
}

interface QuoConversation {
  lastActivityAt?: string | null;
}

/**
 * Activity via the conversations endpoint — lists the line's conversations
 * newest-activity-first WITHOUT requiring participants. Throws on non-2xx;
 * caller wraps in allSettled so schema drift degrades to zero-activity
 * instead of taking the source down.
 */
async function fetchQuoConversationActivity(
  since: Date,
  signal: AbortSignal,
): Promise<QuoConversation[]> {
  const url = new URL(`${QUO_API_ROOT}/conversations`);
  url.searchParams.append("phoneNumbers", QUO_PHONE_ID);
  url.searchParams.set("maxResults", "50");
  const res = await fetch(url.toString(), {
    headers: { Authorization: QUO_API_KEY as string, "Content-Type": "application/json" },
    signal,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`conversations query non-2xx: ${res.status}`);
  }
  const body = (await res.json()) as { data?: QuoConversation[] };
  // Window-filter here so the summarizer stays pure over shaped input.
  return (body.data ?? []).filter((c) => Boolean(c.lastActivityAt));
}

/**
 * Pure summarizer over conversation activity — tests provide synthetic
 * arrays. Always returns api_responsive: true (caller overrides from the
 * probe outcome). Direction is not exposed on conversations, so both
 * recency fields carry the newest lastActivityAt.
 */
export function summarizeConversations(
  conversations: QuoConversation[],
  since: Date,
): QuoState {
  let newest: string | null = null;
  let activeInWindow = 0;
  for (const c of conversations) {
    const at = c.lastActivityAt ?? null;
    if (!at) continue;
    const t = Date.parse(at);
    if (!Number.isFinite(t)) continue;
    if (!newest || t > Date.parse(newest)) newest = at;
    if (t >= since.getTime()) activeInWindow++;
  }
  return {
    api_responsive: true,
    api_key_configured: true,
    most_recent_outbound_at: newest,
    most_recent_inbound_at: newest,
    messages_last_24h: activeInWindow,
  };
}
