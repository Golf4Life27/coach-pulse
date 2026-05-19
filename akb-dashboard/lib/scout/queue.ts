// Phase 4.5 + 4.6 / Q.5 — Scout dispo-readiness queue.
//
// Pure helpers that classify deals for "ready to dispo" — strong
// buyer matches, accepted offer status, DD complete, pricing set.
// Powers the Scout queue endpoint + drives a priority signal in
// the briefing aggregator so Maverick surfaces "N deals ready for
// dispo blast" at session-open.
//
// Coexists with /api/buyers/match-to-deal/[recordId] (per-record
// match) and /api/buyers/fire-blast/[recordId] (per-record send) —
// this is the QUEUE-LEVEL surface that wasn't there.

import type { Listing } from "@/lib/types";

const DISPO_READY_STATUSES = new Set([
  "Offer Accepted",
  "PA Signed",
  "Pending Assignment",
]);

export interface DispoReadinessSignal {
  recordId: string;
  address: string;
  state: string | null;
  outreach_status: string | null;
  list_price: number | null;
  /** Reasons the deal is dispo-ready (positive signals). */
  signals: string[];
  /** Soft blockers operator should review before firing. */
  warnings: string[];
  /** Computed score 0-100 — higher = more ready. */
  readiness_score: number;
}

const READINESS_BASE = 40; // status-gate baseline
const READINESS_PRICING = 25; // has pricing fields
const READINESS_ARV = 15; // has ARV/rehab
const READINESS_RENT = 10; // has rent data
const READINESS_CONTRACT_OFFER = 10; // contract_offer_price locked

/** Pure: classify a single listing's dispo-readiness. Returns null
 *  when the listing isn't even in a dispo-relevant status (filters
 *  out everything pre-Offer-Accepted). */
export function classifyDispoReadiness(listing: Listing): DispoReadinessSignal | null {
  if (!listing.outreachStatus || !DISPO_READY_STATUSES.has(listing.outreachStatus)) {
    return null;
  }
  const signals: string[] = [];
  const warnings: string[] = [];
  let score = READINESS_BASE;

  if (listing.contractOfferPrice && listing.contractOfferPrice > 0) {
    signals.push(`Contract offer $${listing.contractOfferPrice.toLocaleString()}`);
    score += READINESS_CONTRACT_OFFER;
  } else {
    warnings.push("No contract offer price set");
  }
  if (listing.listPrice && listing.listPrice > 0) {
    score += READINESS_PRICING;
  }
  if (listing.realArvMedian && listing.realArvMedian > 0) {
    signals.push(`ARV $${listing.realArvMedian.toLocaleString()}`);
    score += READINESS_ARV;
  } else {
    warnings.push("No ARV — run Appraiser before dispo");
  }
  if (listing.estimatedMonthlyRent && listing.estimatedMonthlyRent > 0) {
    signals.push(`Rent $${listing.estimatedMonthlyRent.toLocaleString()}/mo`);
    score += READINESS_RENT;
  }
  if (listing.arvConfidence === "LOW") {
    warnings.push("ARV confidence LOW — manual review");
    score -= 10;
  }

  return {
    recordId: listing.id,
    address: listing.address,
    state: listing.state,
    outreach_status: listing.outreachStatus,
    list_price: listing.listPrice,
    signals,
    warnings,
    readiness_score: Math.max(0, Math.min(100, score)),
  };
}

/** Pure: classify all listings, sorted by readiness desc. Excludes
 *  records that don't make the dispo-status gate. */
export function buildDispoQueue(listings: Listing[]): DispoReadinessSignal[] {
  return listings
    .map(classifyDispoReadiness)
    .filter((s): s is DispoReadinessSignal => s !== null)
    .sort((a, b) => b.readiness_score - a.readiness_score);
}

/** Pure: top-N high-readiness records suitable for a priority signal
 *  in the briefing aggregator. Drops anything below `min_score`. */
export function selectScoutPrioritySignals(
  listings: Listing[],
  opts: { topN?: number; min_score?: number } = {},
): DispoReadinessSignal[] {
  const topN = opts.topN ?? 5;
  const minScore = opts.min_score ?? 60;
  return buildDispoQueue(listings)
    .filter((s) => s.readiness_score >= minScore)
    .slice(0, topN);
}
