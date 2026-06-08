// RentCast listings intake source adapter (Ship 2 — Crawler source).
// @agent: scout
//
// RentCast /v1/listings/sale returns ACTIVE listings with real list price
// + listed date + agent/office — the listing-data gap ATTOM's snapshot had
// is gone. This is the live intake source; ATTOM is reassigned to the
// Underwriter (INV-023) for deep math (sale history, assessment, AVM,
// owner). Mirrors the ATTOM adapter shape, real fields this time.
//
// Base: https://api.rentcast.io/v1 (shared with lib/rentcast.ts)
// Auth: X-Api-Key: <RENTCAST_API_KEY>
// Discovery: /listings/sale?zipCode={zip}&propertyType=Single Family
//            &status=Active&limit=500
//
// One /listings/sale call per ZIP. Page size default 5, max 500 — we
// request 500 to capture a ZIP's full active set in one call (volume
// snapshot: ~80-135 qualifying/ZIP, well under 500).

import type { IntakeCandidate } from "@/lib/crawler/intake-filter";

const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
const RENTCAST_BASE = "https://api.rentcast.io/v1";
const PAGE_LIMIT = 500;

/** Pure: build the /listings/sale discovery URL for a ZIP (SFR + active). */
export function buildListingsUrl(zip: string, base: string = RENTCAST_BASE): string {
  const u = new URL(`${base}/listings/sale`);
  u.searchParams.set("zipCode", zip);
  u.searchParams.set("propertyType", "Single Family");
  u.searchParams.set("status", "Active");
  u.searchParams.set("limit", String(PAGE_LIMIT));
  return u.toString();
}

// Structural view of a RentCast /listings/sale element (defensive — every
// field optional). Confirmed shape from operator live sanity test 2026-05-25.
interface RentCastHistoryEvent {
  event?: string;
  price?: number;
  listingType?: string;
  listedDate?: string;
}
interface RentCastListing {
  id?: string;
  formattedAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  /** Year built — RentCast returns this on some /listings/sale payloads;
   *  absent on others. Optional; Station 2 ENRICH backfill picks up the
   *  null records via the per-record /properties query. */
  yearBuilt?: number;
  status?: string;
  price?: number;
  listedDate?: string;
  daysOnMarket?: number;
  mlsName?: string;
  mlsNumber?: string;
  history?: Record<string, RentCastHistoryEvent> | RentCastHistoryEvent[];
  // Agent/office contact. RentCast returns these on most active listings;
  // every sub-field is optional (defensive — never assume presence).
  listingAgent?: { name?: string; phone?: string; email?: string };
  listingOffice?: { name?: string };
}

/** Pure: detect a price reduction across the listing's history. RentCast
 *  history is keyed by date (object) or an array; handle both.
 *
 *  Used as a Phase-2 distress accept signal (mapped onto the candidate's
 *  priceReduced) AND by INV-030 downstream re-engagement. The basic price/
 *  beds/SFR/state intake gate is unaffected — a price drop only widens what
 *  counts as a clean "accept" vs the soft "review" queue post-verification. */
export function detectPriceReduction(
  history: RentCastListing["history"],
  currentPrice: number | null | undefined,
): boolean {
  const events: RentCastHistoryEvent[] = Array.isArray(history)
    ? history
    : history
      ? Object.values(history)
      : [];
  const prices = events
    .map((e) => e.price)
    .filter((p): p is number => typeof p === "number" && p > 0);
  if (prices.length >= 2) {
    // Any later price lower than an earlier one = a reduction.
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] < prices[i - 1]) return true;
    }
  }
  // Single historical price above current list price → reduced since.
  if (prices.length >= 1 && currentPrice != null && prices[0] > currentPrice) {
    return true;
  }
  return false;
}

/** Pure: parse the city from a RentCast formattedAddress when the explicit
 *  city field is absent. "123 Main St, San Antonio, TX 78210" → "San Antonio". */
export function cityFromFormatted(formatted: string | null | undefined): string | null {
  if (!formatted) return null;
  const parts = formatted.split(",").map((s) => s.trim());
  // [street, city, "STATE ZIP"] — city is the second-to-last part.
  return parts.length >= 3 ? parts[parts.length - 2] : null;
}

/** Pure: map one RentCast listing → vendor-agnostic IntakeCandidate. */
export function mapListingToCandidate(l: RentCastListing): IntakeCandidate {
  const sourceId = l.id
    ? `rentcast:${l.id}`
    : l.mlsNumber
      ? `rentcast:mls:${l.mlsNumber}`
      : `rentcast:${l.formattedAddress ?? "unknown"}`;
  return {
    sourceId,
    address: l.formattedAddress ?? null,
    city: l.city ?? cityFromFormatted(l.formattedAddress),
    state: l.state ?? null,
    zip: l.zipCode ?? null,
    propertyType: l.propertyType ?? null,
    beds: l.bedrooms ?? null,
    listPrice: l.price ?? null,
    listedDate: l.listedDate ?? null,
    agentName: l.listingAgent?.name ?? null,
    agentPhone: l.listingAgent?.phone ?? null,
    agentEmail: l.listingAgent?.email ?? null,
    brokerageName: l.listingOffice?.name ?? null,
    // Phase-2 distress accept signals — both straight from the feed, no extra
    // API call. priceReduced reuses the existing history primitive.
    daysOnMarket: l.daysOnMarket ?? null,
    priceReduced: detectPriceReduction(l.history, l.price ?? null),
    // Station 2 ENRICH — structural facts pass through from the same
    // /listings/sale payload we already pay for (zero new API calls). The
    // Station 2 per-record backfill only fires for records that LAND with
    // these fields null (older intake, RentCast omitted them, etc).
    squareFootage: l.squareFootage ?? null,
    bathrooms: l.bathrooms ?? null,
    yearBuilt: l.yearBuilt ?? null,
  };
}

/** Pure: map a RentCast listings array → candidates. */
export function mapListingsResponse(body: unknown): IntakeCandidate[] {
  if (!Array.isArray(body)) return [];
  return (body as RentCastListing[]).map(mapListingToCandidate);
}

export interface RentcastFetchResult {
  candidates: IntakeCandidate[];
  credentialed: boolean;
  error: string | null;
  raw_count: number;
}

/** Fetch + normalize RentCast active listings for one ZIP. credentialed=false
 *  (no candidates) when RENTCAST_API_KEY is unset. Throws are caught and
 *  returned as `error` so one bad ZIP doesn't abort the cron's loop. */
export async function fetchListingsByZip(zip: string): Promise<RentcastFetchResult> {
  if (!RENTCAST_API_KEY) {
    return { candidates: [], credentialed: false, error: "RENTCAST_API_KEY not set", raw_count: 0 };
  }
  try {
    const res = await fetch(buildListingsUrl(zip), {
      headers: { "X-Api-Key": RENTCAST_API_KEY, accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        candidates: [],
        credentialed: true,
        error: `RentCast listings/sale ${res.status}: ${await res.text().catch(() => "")}`.slice(0, 300),
        raw_count: 0,
      };
    }
    const body = await res.json();
    const candidates = mapListingsResponse(body);
    return { candidates, credentialed: true, error: null, raw_count: candidates.length };
  } catch (err) {
    return {
      candidates: [],
      credentialed: true,
      error: err instanceof Error ? err.message : String(err),
      raw_count: 0,
    };
  }
}
