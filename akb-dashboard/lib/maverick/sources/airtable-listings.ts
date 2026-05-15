// Maverick source — Airtable Listings_V1.
// @agent: maverick
//
// Surfaces active-deal state for the briefing: counts by Outreach_Status,
// the active-negotiation cohort with addresses + ages, the Texted
// universe size. Reuses lib/airtable.getListings() (already cached
// in-process with a 60s TTL).
//
// Budget: 8s (Airtable getListings was ~6s in 5/14 smoke).
// Spec v1.1 §5 Step 1.

import { getListings } from "@/lib/airtable";
import type { Listing } from "@/lib/types";
import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";

// Bumped from 8s → 15s after Gate 2 first-smoke (5/15) observed
// concurrent Airtable fetches contending: when all 3 Airtable calls
// (listings + spine + queue) race in parallel, the slowest can hit
// 8s. 15s gives headroom; the aggregator's overall 30s P95 budget
// absorbs it since other sources finish much faster.
const DEFAULT_TIMEOUT_MS = 15_000;

// Statuses that represent active engagement past first-touch. The
// briefing surfaces these as "active deals" — listing them out
// explicitly so future status additions are intentional, not
// silently inherited.
const ACTIVE_DEAL_STATUSES = new Set([
  "negotiating",
  "counter received",
  "response received",
  "offer accepted",
]);

export interface ListingsActiveDeal {
  id: string;
  address: string;
  city: string | null;
  status: string;
  list_price: number | null;
  stored_offer_price: number | null;
  last_outreach_date: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  agent_name: string | null;
  days_since_send: number | null;
  days_since_inbound: number | null;
}

export interface AirtableListingsState {
  pipeline_counts: Record<string, number>;
  active_deals: ListingsActiveDeal[];
  texted_universe_size: number;
  total_listings: number;
}

export async function fetchAirtableListingsState(
  opts: FetchOpts = {},
): Promise<SourceResult<AirtableListingsState>> {
  return runWithTimeout(
    { source: "airtable_listings", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async () => {
      const listings = await getListings();
      return summarizeListings(listings, new Date());
    },
  );
}

/**
 * Pure summarizer — tests hit this with a fixed Date(now) and a
 * synthetic Listing[] to avoid Airtable I/O.
 */
export function summarizeListings(
  listings: Listing[],
  now: Date,
): AirtableListingsState {
  const counts: Record<string, number> = {};
  const active: ListingsActiveDeal[] = [];

  for (const l of listings) {
    const statusRaw = l.outreachStatus ?? "(unset)";
    counts[statusRaw] = (counts[statusRaw] ?? 0) + 1;

    const statusLower = statusRaw.toLowerCase();
    if (ACTIVE_DEAL_STATUSES.has(statusLower)) {
      active.push({
        id: l.id,
        address: l.address ?? "(no address)",
        city: l.city ?? null,
        status: statusRaw,
        list_price: l.listPrice ?? null,
        stored_offer_price: l.storedOfferPrice ?? null,
        last_outreach_date: l.lastOutreachDate ?? null,
        last_inbound_at: l.lastInboundAt ?? null,
        last_outbound_at: l.lastOutboundAt ?? null,
        agent_name: l.agentName ?? null,
        days_since_send: daysBetween(now, l.lastOutboundAt ?? l.lastOutreachDate),
        days_since_inbound: daysBetween(now, l.lastInboundAt),
      });
    }
  }

  // Sort active deals by most-recent activity first so the briefing
  // surfaces the freshest engagement at the top.
  active.sort((a, b) => {
    const aMs = msOf(a.last_inbound_at ?? a.last_outbound_at ?? a.last_outreach_date);
    const bMs = msOf(b.last_inbound_at ?? b.last_outbound_at ?? b.last_outreach_date);
    return bMs - aMs;
  });

  return {
    pipeline_counts: counts,
    active_deals: active,
    texted_universe_size: counts["Texted"] ?? 0,
    total_listings: listings.length,
  };
}

function daysBetween(now: Date, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

function msOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}
