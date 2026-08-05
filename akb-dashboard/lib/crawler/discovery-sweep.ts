// THE HUNT — find properties that fit the target, without RentCast.
// @agent: scout
//
// Discovery used to be gated on RentCast, whose monthly plan divided by days
// left IS the daily crawl budget (~30 ZIP scans/day). This lane finds leads on
// Firecrawl instead, which has ~90,700 credits sitting idle, and reserves
// RentCast for the one thing only it provides: the agent phone number that
// makes a qualifying listing textable.
//
// SHAPE: for each ZIP on the circuit leg —
//   1. ONE /v2/search for listing URLs in that ZIP (~1 credit).
//   2. Drop URLs we already hold (dedup BEFORE spending a scrape — the same
//      rule intake follows).
//   3. Scrape each NEW url through the EXISTING verifyListingByUrl, which
//      already extracts price + sqft and runs every hard veto (renovated,
//      new-construction, wholesaler-excluded, inactive). ~1 credit each.
//   4. Screen survivors against lib/buy-box.
//   5. Hand qualifiers on for RentCast enrichment. Nothing else costs a call.
//
// COST, honestly: the FIRST pass over a ZIP is ~1 + N credits (N = new URLs).
// At N≈20 that is ~21/ZIP, so a first full circuit of ~120 ZIPs is roughly
// 2,500 credits. Every later circuit is far cheaper because step 2 drops
// everything already known — steady state is a handful of credits per ZIP.
// Against ~90,700 on hand that is dozens of full circuits either way, but the
// earlier "~500 per circuit" figure was the search leg only and was wrong.

import {
  SHAPE,
  maxAskFor,
  hasAny,
  DISTRESS_KEYWORDS,
  EXCLUDE_KEYWORDS,
  LANDLORD_PITCH_KEYWORDS,
  DISTRESS_DOM_DAYS,
} from "@/lib/buy-box";

/** Portals whose listing pages carry the copy our classifiers read. */
export const LISTING_HOSTS: readonly string[] = ["zillow.com", "redfin.com", "realtor.com", "homes.com"];

/** Pure: the search that finds distressed inventory in one ZIP. Written to
 *  bias the index toward the copy we actually want rather than toward every
 *  active listing — "as-is"/"investor"/"fixer" pull the motivated tail, which
 *  is the only part of an on-market ZIP worth paying to read. */
export function buildZipSearchQuery(zip: string, city?: string | null, state?: string | null): string {
  const place = [city, state].filter(Boolean).join(" ");
  const where = place ? `${place} ${zip}` : zip;
  return `houses for sale ${where} as-is OR "investor special" OR fixer OR "needs work" site:zillow.com OR site:redfin.com`;
}

/** Pure: is this a single LISTING page (not a search page, agent profile, or
 *  neighbourhood hub)? Spending a scrape on a search page is pure waste — it
 *  carries no single subject and every classifier returns noise. */
export function isListingUrl(url: string | null | undefined): boolean {
  const u = (url ?? "").toLowerCase();
  if (!u.startsWith("http")) return false;
  if (!LISTING_HOSTS.some((h) => u.includes(h))) return false;
  // Reject index/search/browse shapes.
  if (/\/(homes|for_sale|for-sale|search|city|neighborhood|agent|profile|community)\/?($|\?)/.test(u)) return false;
  if (u.includes("_rb/") && !/\d/.test(u.split("_rb/")[1] ?? "")) return false;
  // A listing URL carries a street number or a listing id.
  return /\/\d+[-_]/.test(u) || /\/homedetails\//.test(u) || /\/home\/\d+/.test(u);
}

export interface SweepCandidate {
  url: string;
  zip: string;
  city?: string | null;
  /** From the scraped page (verifyListingByUrl extracts these). */
  price?: number | null;
  sqft?: number | null;
  beds?: number | null;
  baths?: number | null;
  yearBuilt?: number | null;
  daysOnMarket?: number | null;
  priceCutPct?: number | null;
  /** Page text for copy screening. Best-effort: the scraper returns a capped
   *  excerpt, so precomputed signals below are preferred where they exist. */
  text?: string | null;
  /** Distress language decided by classifyVerifiedListing over the FULL page
   *  text — authoritative, and preferred over scanning the capped excerpt. */
  hasDistressLanguage?: boolean;
  /** Hard vetoes already decided by classifyVerifiedListing. */
  renovated?: boolean;
  newConstruction?: boolean;
  wholesalerExcluded?: boolean;
  stillActive?: boolean;
}

export type SweepRejectReason =
  | "not_listing_url"
  | "ask_above_ceiling"
  | "ask_below_floor"
  | "beds_below_min"
  | "sqft_out_of_band"
  | "year_built_out_of_band"
  | "renovated"
  | "new_construction"
  | "wholesaler_excluded"
  | "not_active"
  | "excluded_language"
  | "landlord_priced"
  | "no_distress_signal";

export interface SweepScreen {
  accept: boolean;
  reasons: SweepRejectReason[];
  /** Distress evidence that earned the accept — kept for the audit trail so a
   *  send can always be traced to why we thought the seller was motivated. */
  distress: string[];
}

/**
 * Pure: does this candidate hit the target?
 *
 * Order matters for cost only in the caller; here every reason is collected so
 * a sweep can report WHY a ZIP produced nothing instead of just a count. An
 * unknown value never rejects — absent beds or sqft means "we could not read
 * it", not "it fails" (INVARIANTS §1: no guessing). Shape unknowns pass to
 * enrichment; only affirmative disqualifiers reject.
 */
export function screenCandidate(c: SweepCandidate): SweepScreen {
  const reasons: SweepRejectReason[] = [];
  const distress: string[] = [];

  if (!isListingUrl(c.url)) reasons.push("not_listing_url");

  // Hard vetoes already decided upstream by classifyVerifiedListing.
  if (c.renovated) reasons.push("renovated");
  if (c.newConstruction) reasons.push("new_construction");
  if (c.wholesalerExcluded) reasons.push("wholesaler_excluded");
  if (c.stillActive === false) reasons.push("not_active");

  // Price against the metro's derived ceiling.
  if (typeof c.price === "number" && c.price > 0) {
    const ceiling = maxAskFor(c.city);
    if (c.price > ceiling) reasons.push("ask_above_ceiling");
    if (c.price < 15_000) reasons.push("ask_below_floor");
  }

  if (typeof c.beds === "number" && c.beds > 0 && c.beds < SHAPE.minBeds) reasons.push("beds_below_min");
  if (typeof c.sqft === "number" && c.sqft > 0 && (c.sqft < SHAPE.minSqft || c.sqft > SHAPE.maxSqft)) {
    reasons.push("sqft_out_of_band");
  }
  if (
    typeof c.yearBuilt === "number" &&
    c.yearBuilt > 0 &&
    (c.yearBuilt < SHAPE.minYearBuilt || c.yearBuilt > SHAPE.maxYearBuilt)
  ) {
    reasons.push("year_built_out_of_band");
  }

  const text = c.text ?? "";
  if (hasAny(text, EXCLUDE_KEYWORDS)) reasons.push("excluded_language");

  // Distress — at least one signal is REQUIRED. This is what creates the deal;
  // everything above only decides whether the ARV is big enough to hold a fee.
  if (typeof c.daysOnMarket === "number" && c.daysOnMarket >= DISTRESS_DOM_DAYS) {
    distress.push(`dom_${c.daysOnMarket}`);
  }
  if (typeof c.priceCutPct === "number" && c.priceCutPct >= 0.05) {
    distress.push(`price_cut_${Math.round(c.priceCutPct * 100)}pct`);
  }
  // Prefer the classifier's verdict over the capped excerpt.
  const distressLanguage = c.hasDistressLanguage ?? hasAny(text, DISTRESS_KEYWORDS);
  if (distressLanguage) distress.push("distress_language");
  if (distress.length === 0) reasons.push("no_distress_signal");

  // Landlord-yield marketing: priced for the buyer we would assign TO, so the
  // spread is gone before we arrive. Only disqualifying when the listing shows
  // NO distress of its own — "investor special, needs work" plus a proforma is
  // still a deal; a clean cash-flow pitch is not.
  if (hasAny(text, LANDLORD_PITCH_KEYWORDS) && !distressLanguage) {
    reasons.push("landlord_priced");
  }

  return { accept: reasons.length === 0, reasons, distress };
}

/** Pure: roll per-candidate screens into the per-ZIP line a run summary needs. */
export function summarizeScreens(screens: SweepScreen[]): {
  examined: number;
  qualified: number;
  by_reason: Record<string, number>;
} {
  const by_reason: Record<string, number> = {};
  let qualified = 0;
  for (const s of screens) {
    if (s.accept) qualified++;
    for (const r of s.reasons) by_reason[r] = (by_reason[r] ?? 0) + 1;
  }
  return { examined: screens.length, qualified, by_reason };
}
