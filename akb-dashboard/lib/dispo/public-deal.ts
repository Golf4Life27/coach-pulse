// PUBLIC DEAL PAGE — the buyer-facing projection of a Listing (2026-09-05).
//
// WHY A SEPARATE PROJECTION AND NOT "just don't render the private fields":
// the public deal page (app/d/[recordId]) and its API route
// (app/api/public/deal/[recordId]) are the ONE unauthenticated read path in
// this codebase. A field added to the page template later (or a stray
// `{...listing}` spread) must not be able to leak listPrice, contract/offer
// prices, ARV, rehab, fee, spread, or agent/notes to an anonymous wholesale
// buyer. Routing everything through this single pure allowlist function
// means the leak surface is one file, and it is unit-tested against the
// literal words that must never appear in the output.
//
// `dispoPublic` is the switch: Alex opts a deal INTO buyer visibility. Until
// then this returns null and the page/route 404, regardless of what else is
// populated on the record.

import type { Listing } from "@/lib/types";

export interface PublicDealView {
  recordId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  yearBuilt: number | null;
  propertyType: string | null;
  assignmentPrice: number | null;
  optionDeadline: string | null;
  closeDate: string | null;
  photos: string[];
  headline: string;
}

/** `dealPhotoUrls` is a JSON array string written by an upstream step and
 *  may be null, empty, or malformed — never trust it, always degrade to []. */
function parsePhotos(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

/**
 * Pure. Returns the buyer-safe view of a listing, or null when the deal is
 * not (or no longer) opted into public visibility — the ONLY gate the public
 * route needs to check before a 404.
 */
export function publicDealView(listing: Listing): PublicDealView | null {
  if (listing.dispoPublic !== true) return null;

  return {
    recordId: listing.id,
    address: listing.address,
    city: listing.city,
    state: listing.state ?? "",
    zip: listing.zip,
    beds: listing.bedrooms,
    baths: listing.bathrooms,
    sqft: listing.buildingSqFt,
    yearBuilt: listing.yearBuilt,
    propertyType: listing.propertyType ?? null,
    assignmentPrice: listing.assignmentPrice ?? null,
    optionDeadline: listing.optionDeadline ?? null,
    closeDate: listing.closeDate ?? null,
    photos: parsePhotos(listing.dealPhotoUrls),
    headline: `Off-market: ${listing.address}`,
  };
}
