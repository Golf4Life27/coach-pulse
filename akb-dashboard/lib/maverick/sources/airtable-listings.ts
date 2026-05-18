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
import { classifyBbcTierFromRate } from "@/lib/appraiser/rehab-calibration";
import { computeDualTrack, type DominantTrack } from "@/lib/appraiser/buyer-intelligence";

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
  // Phase 20.2 v1.3 (5/18) — Stored_Offer_Price replaced by the
  // two-field model. outreach_offer_price = sticky 65% set at outreach;
  // contract_offer_price = operative offer set later by Pricing Agent
  // at negotiation/DD. The template renderer prefers contract over
  // outreach when both exist.
  outreach_offer_price: number | null;
  contract_offer_price: number | null;
  seller_motivation_score: number | null;
  last_outreach_date: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  agent_name: string | null;
  days_since_send: number | null;
  days_since_inbound: number | null;
  // Phase 4A.1 (5/18) — ARV state per active deal so the Appraiser
  // room can roll up coverage / staleness / low-confidence counts
  // without re-fetching Airtable.
  real_arv_median: number | null;
  arv_confidence: "HIGH" | "MED" | "LOW" | null;
  arv_validated_at: string | null;
  /** "current" (validated ≤30d), "stale" (>30d), "missing" (null). */
  arv_freshness: "current" | "stale" | "missing";
  /** Days since last ARV validation; null when never validated. */
  arv_age_days: number | null;
  // Phase 4B.1 (5/18) — Rehab state per active deal. Same pattern as
  // ARV state above so the Appraiser room can roll up rehab coverage
  // alongside ARV coverage.
  est_rehab_mid: number | null;
  rehab_confidence_score: number | null;
  rehab_estimated_at: string | null;
  /** BBC tier derived from est_rehab_mid / building_sqft via midpoint
   *  thresholds. Null when rehab or sqft is missing. */
  bbc_tier: "Cosmetic" | "Light" | "Medium" | "Heavy" | "Gut" | null;
  /** "current" (estimated ≤30d), "stale" (>30d), "missing" (null). */
  rehab_freshness: "current" | "stale" | "missing";
  /** Days since last rehab estimate; null when never estimated. */
  rehab_age_days: number | null;
  // Phase 4C.1 (5/18) — Dual-track buyer intelligence per active deal.
  // Computed inline from listing inputs + per-state cap rate. The
  // Appraiser room rolls up track-mix counters; the deal-detail panel
  // surfaces flipper vs landlord side-by-side with dominant highlighted.
  estimated_monthly_rent: number | null;
  flipper_mao: number | null;
  landlord_mao: number | null;
  dominant_track: DominantTrack;
  /** The higher of flipper_mao / landlord_mao — the buyer-facing MAO
   *  ceiling. Null when both tracks return null. */
  dominant_value: number | null;
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
      const arvAgeDays = daysBetween(now, l.arvValidatedAt ?? null);
      const arvFreshness: ListingsActiveDeal["arv_freshness"] =
        l.arvValidatedAt == null
          ? "missing"
          : arvAgeDays != null && arvAgeDays > 30
            ? "stale"
            : "current";
      const rehabAgeDays = daysBetween(now, l.rehabEstimatedAt ?? null);
      const rehabFreshness: ListingsActiveDeal["rehab_freshness"] =
        l.rehabEstimatedAt == null
          ? "missing"
          : rehabAgeDays != null && rehabAgeDays > 30
            ? "stale"
            : "current";
      // BBC tier inferred from calibrated rate ($/sqft); null when
      // rehab or sqft is missing. Falls back to estRehab when
      // estRehabMid is null (Phase 4B endpoint writes both, but
      // pre-Phase-4B records may only have estRehab from old pricing).
      const rehabMid = l.estRehabMid ?? l.estRehab ?? null;
      const bbcTier: ListingsActiveDeal["bbc_tier"] =
        rehabMid != null && l.buildingSqFt != null && l.buildingSqFt > 0
          ? classifyBbcTierFromRate(rehabMid / l.buildingSqFt)
          : null;
      // Phase 4C.1 — dual-track buyer intelligence inline. Same
      // pattern as bbc_tier above: compute per active deal so the
      // Appraiser room rollup + deal-detail panel both read from the
      // briefing without re-fetching Airtable.
      const dualTrack = computeDualTrack({
        arvMid: l.realArvMedian ?? null,
        estRehab: rehabMid,
        wholesaleFee: l.wholesaleFeeTarget ?? null,
        monthlyRent: l.estimatedMonthlyRent ?? null,
        state: l.state,
      });
      active.push({
        id: l.id,
        address: l.address ?? "(no address)",
        city: l.city ?? null,
        status: statusRaw,
        list_price: l.listPrice ?? null,
        outreach_offer_price: l.outreachOfferPrice ?? null,
        contract_offer_price: l.contractOfferPrice ?? null,
        seller_motivation_score: l.sellerMotivationScore ?? null,
        last_outreach_date: l.lastOutreachDate ?? null,
        last_inbound_at: l.lastInboundAt ?? null,
        last_outbound_at: l.lastOutboundAt ?? null,
        agent_name: l.agentName ?? null,
        days_since_send: daysBetween(now, l.lastOutboundAt ?? l.lastOutreachDate),
        days_since_inbound: daysBetween(now, l.lastInboundAt),
        real_arv_median: l.realArvMedian ?? null,
        arv_confidence: l.arvConfidence ?? null,
        arv_validated_at: l.arvValidatedAt ?? null,
        arv_freshness: arvFreshness,
        arv_age_days: arvAgeDays,
        est_rehab_mid: rehabMid,
        rehab_confidence_score: l.rehabConfidenceScore ?? null,
        rehab_estimated_at: l.rehabEstimatedAt ?? null,
        bbc_tier: bbcTier,
        rehab_freshness: rehabFreshness,
        rehab_age_days: rehabAgeDays,
        estimated_monthly_rent: l.estimatedMonthlyRent ?? null,
        flipper_mao: dualTrack.flipper_mao,
        landlord_mao: dualTrack.landlord_mao,
        dominant_track: dualTrack.dominant_track,
        dominant_value: dualTrack.dominant_value,
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
