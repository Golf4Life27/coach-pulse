// matchPricingBuyer — the Tier-C pricing-buyer selector (adjudication
// recXJrM7EYK3pEFmF item 2). @agent: appraiser/dispo
//
// THE RULE: a property-up autonomous offer is authorized only when ONE
// buyer's box demonstrably fits THIS property. A ZIP average prices no
// single house, and a top-25 triage list selects no margin. This module
// returns exactly one buyer or an explicit HOLD — never a guess.
//
// HARD FILTERS (all must pass; any fail excludes the buyer):
//   1. state         — buyer's Preferred_States contains the listing state
//   2. track         — buyer type matches the listing's resolved track
//                      (flipper/landlord; Strategy_Type fallback when the
//                      Buyer_Type column is unset on legacy rows)
//   3. POF           — Proof_of_Funds_On_File true AND not expired
//   4. margin        — Min_Deal_Spread non-null and positive (the Tier-C
//                      margin source; null = the buyer can't price)
//   5. band          — the buyer's OWN resulting purchase price
//                      (ARV − their spread) fits their Min/Max price band.
//                      Computed per-buyer to avoid the circularity of
//                      filtering on a price that depends on the buyer.
//
// TIEBREAK among qualified: highest Min_Deal_Spread wins — the most
// conservative offer, assignable to every looser buyer behind him.
//
// Non-POF / null-spread buyers stay in the existing match-to-deal top-25
// triage output (informational); this selector is the only one that can
// authorize pricing.

import type { BuyerRecord } from "@/types/jarvis";
import type { BuyerTrack } from "@/lib/buyer-median-input";

export interface PricingBuyerListing {
  state: string | null;
  track: BuyerTrack;
  /** Real_ARV_Median — comp-sourced. Required to evaluate band fit. */
  arv: number | null;
}

export type PricingBuyerResult =
  | { matched: true; buyer: BuyerRecord; buyerPurchasePrice: number; qualifiedCount: number }
  | { matched: false; hold: true; reason: "no_matching_buyer_for_pricing"; detail: string };

/** Strategy_Type → track, for legacy rows without a Buyer_Type column.
 *  Flip/Wholesale → flipper; Buy-and-Hold/BRRRR/Rental/Section 8 → landlord.
 *  A buyer listing strategies on BOTH sides matches either track. */
export function buyerTracks(b: BuyerRecord): Set<BuyerTrack> {
  const out = new Set<BuyerTrack>();
  if (b.buyerType === "flipper" || b.buyerType === "landlord") out.add(b.buyerType);
  for (const s of b.strategyType ?? []) {
    const v = s.toLowerCase();
    if (v.includes("flip") || v.includes("wholesale") || v.includes("teardown") || v.includes("land")) out.add("flipper");
    if (v.includes("hold") || v.includes("brrrr") || v.includes("rental") || v.includes("section 8")) out.add("landlord");
  }
  return out;
}

function pofValid(b: BuyerRecord, now: Date): boolean {
  if (!b.pofOnFile) return false;
  if (b.pofExpiryDate) {
    const t = Date.parse(b.pofExpiryDate);
    if (Number.isFinite(t) && t < now.getTime()) return false; // expired
  }
  return true;
}

function stateMatches(b: BuyerRecord, state: string | null): boolean {
  if (!state) return false;
  const wanted = state.trim().toUpperCase();
  const prefs = (b.preferredStates ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (prefs.includes(wanted)) return true;
  // markets[] fallback (V2-written rows carry Markets, not Preferred_States)
  const markets = (b.markets ?? []).map((m) => m.toLowerCase());
  if (wanted === "MI" && markets.includes("detroit")) return true;
  if (wanted === "TN" && markets.includes("memphis")) return true;
  if (wanted === "TX" && (markets.includes("san antonio") || markets.includes("dallas") || markets.includes("houston"))) return true;
  if (wanted === "GA" && markets.includes("atlanta")) return true;
  return false;
}

/**
 * Pure: select THE pricing buyer for a listing, or HOLD. The caller
 * supplies the candidate pool (I/O stays at the route/station layer).
 */
export function matchPricingBuyer(
  listing: PricingBuyerListing,
  buyers: BuyerRecord[],
  now: Date = new Date(),
): PricingBuyerResult {
  if (listing.arv == null || !Number.isFinite(listing.arv) || listing.arv <= 0) {
    return { matched: false, hold: true, reason: "no_matching_buyer_for_pricing", detail: "listing ARV missing — band fit cannot be evaluated (source ARV first)" };
  }

  const failures = { state: 0, track: 0, pof: 0, spread: 0, band: 0 };
  const qualified: Array<{ buyer: BuyerRecord; purchase: number }> = [];

  for (const b of buyers) {
    if (!stateMatches(b, listing.state)) { failures.state++; continue; }
    if (!buyerTracks(b).has(listing.track)) { failures.track++; continue; }
    if (!pofValid(b, now)) { failures.pof++; continue; }
    if (b.minDealSpread == null || !Number.isFinite(b.minDealSpread) || b.minDealSpread <= 0) { failures.spread++; continue; }

    // Band fit on the buyer's OWN resulting purchase price.
    const purchase = Math.round(listing.arv - b.minDealSpread);
    if (purchase <= 0) { failures.band++; continue; }
    if (b.minPrice != null && purchase < b.minPrice) { failures.band++; continue; }
    if (b.maxPrice != null && purchase > b.maxPrice) { failures.band++; continue; }

    qualified.push({ buyer: b, purchase });
  }

  if (qualified.length === 0) {
    return {
      matched: false,
      hold: true,
      reason: "no_matching_buyer_for_pricing",
      detail:
        `0 of ${buyers.length} buyers qualified — excluded by: state=${failures.state}, ` +
        `track=${failures.track}, pof=${failures.pof}, null_spread=${failures.spread}, band=${failures.band}. ` +
        `Tier C holds until a POF-verified buyer with a sourced Min_Deal_Spread fits this box.`,
    };
  }

  // Highest spread wins — most conservative offer, assignable to every
  // looser buyer behind him. Stable tiebreak on id for determinism.
  qualified.sort((a, b) => (b.buyer.minDealSpread! - a.buyer.minDealSpread!) || a.buyer.id.localeCompare(b.buyer.id));
  const top = qualified[0];
  return { matched: true, buyer: top.buyer, buyerPurchasePrice: top.purchase, qualifiedCount: qualified.length };
}
