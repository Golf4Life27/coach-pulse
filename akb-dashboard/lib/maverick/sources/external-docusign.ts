// Maverick source — DocuSign envelope state.
// @agent: scribe (Phase 5.2)
//
// Reads the last 30 days of envelopes from DocuSign via lib/docusign,
// summarizes each into the slim shape the Scribe room consumes, then
// rolls up into briefing-level counts. Degrades to an empty state
// (configured:false) when DOCUSIGN_* env vars aren't set — keeps the
// Scribe room rendering "Standing by — credentials pending" rather
// than failing the briefing.
//
// Budget: 5s. DocuSign listEnvelopes is typically 200-800ms but the
// follow-up per-envelope recipient fetch (one per active envelope)
// can stack — we cap the recipient-detail fanout at ENVELOPE_DETAIL_CAP
// to keep total fetch within budget.

import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";
import {
  docusignConfigured,
  listEnvelopes,
  listRecipients,
  summarizeEnvelope,
  rollupEnvelopes,
  isEnvelopeInFlight,
  type DocusignEnvelope,
  type EnvelopeSummary,
  type DocusignRollup,
} from "@/lib/docusign";

const DEFAULT_TIMEOUT_MS = 5_000;
const LOOKBACK_DAYS = 30;
// Cap recipient-detail fetches per refresh. In-flight envelopes get
// recipient detail (so Scribe can show "awaiting Candice"); completed/
// voided envelopes are summarized without recipient detail.
const ENVELOPE_DETAIL_CAP = 10;

export interface DocusignState {
  configured: boolean;
  api_reachable: boolean;
  // Rolled-up counts the Scribe room renders directly.
  rollup: DocusignRollup;
  // Slim per-envelope shapes the deal-detail panel reads from
  // (filtered by Envelope_ID on the Listings_V1 record).
  envelopes: EnvelopeSummary[];
  // ISO of the last refresh — surfaces in source_health staleness.
  fetched_at: string;
}

export const EMPTY_DOCUSIGN: DocusignState = {
  configured: false,
  api_reachable: false,
  rollup: {
    active_count: 0,
    awaiting_alex_count: 0,
    signed_this_week: 0,
    voided_or_expired: 0,
    max_awaiting_alex_hours: null,
  },
  envelopes: [],
  fetched_at: "",
};

export async function fetchDocusignState(
  opts: FetchOpts = {},
): Promise<SourceResult<DocusignState>> {
  return runWithTimeout(
    {
      source: "external_docusign",
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
    async () => {
      if (!docusignConfigured()) {
        // Not a failure — Scribe room degrades cleanly.
        return {
          ...EMPTY_DOCUSIGN,
          fetched_at: new Date().toISOString(),
        };
      }
      const fromDate = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const envelopes = await listEnvelopes({ fromDate, count: 50 });
      const summaries = await summarizeManyEnvelopes(envelopes);
      return {
        configured: true,
        api_reachable: true,
        rollup: rollupEnvelopes(summaries),
        envelopes: summaries,
        fetched_at: new Date().toISOString(),
      };
    },
  );
}

/**
 * For each envelope, build a summary. In-flight envelopes pull
 * recipient detail (so we can compute "awaiting Alex" + max
 * awaiting hours); terminal envelopes summarize without recipient
 * detail to stay inside the timeout budget. Exported for tests.
 */
export async function summarizeManyEnvelopes(
  envelopes: DocusignEnvelope[],
  fetchRecipients: (envelopeId: string) => Promise<Awaited<ReturnType<typeof listRecipients>>> = listRecipients,
): Promise<EnvelopeSummary[]> {
  const out: EnvelopeSummary[] = [];
  let detailFetched = 0;
  for (const env of envelopes) {
    const inFlight = isEnvelopeInFlight(
      (env.status ?? "").toLowerCase() as Parameters<typeof isEnvelopeInFlight>[0],
    );
    let recipients: Awaited<ReturnType<typeof listRecipients>> = [];
    if (inFlight && detailFetched < ENVELOPE_DETAIL_CAP) {
      try {
        recipients = await fetchRecipients(env.envelopeId);
        detailFetched++;
      } catch {
        // Recipient fetch failed for this envelope — fall back to
        // envelope-only summary (no awaiting_recipient_name). The
        // rollup still counts it as active.
      }
    }
    out.push(summarizeEnvelope(env, recipients));
  }
  return out;
}
