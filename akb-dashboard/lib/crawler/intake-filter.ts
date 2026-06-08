// Vendor-agnostic intake filter (Ship 2 — ATTOM auto-intake, reusable).
// @agent: scout
//
// Pure. Operates on a normalized IntakeCandidate so it's reusable across
// any source (ATTOM today; PropStream/MLS/manual later). The source
// adapter (e.g. lib/crawler/sources/attom.ts) maps vendor JSON → this
// shape; the filter never sees vendor-specific fields.
//
// Established intake rules (locked 2026-05-25; distress dropped per
// operator 2026-05-25):
//   - propertyType = SFR (single-family residential)
//   - beds >= 2
//   - $20,000 <= listPrice <= $400,000 (flat band; floor lowered from
//     $75K per operator 2026-05-25 — tune from dry-run output)
//   - NO DOM lower floor (removed 2026-05-26): fire on EVERY active band
//     listing regardless of age — fresh-but-distress listings (e.g. an
//     "as-is" home 3 days on market) are exactly the first-low-offer
//     targets and must not be dropped for being too new. Optional
//     DISTRESS_DOM_CAP upper bound still drops stale market noise.
//   - State NOT IN {IL, MO, SC, NC, OK, ND} (wholesale-restrictive)
//
// NO distress-signal gate at intake: the 65%-of-list outreach script is
// itself the door-opener, and first contact should fire on EVERY active
// band listing (long-DOM deals are exactly where we want the first low
// offer). Volume up substantially — intentional. Price-reduction detection
// is a SEPARATE downstream re-engagement trigger (INV-030), NOT intake.

export const EXCLUDED_STATES: ReadonlySet<string> = new Set([
  "IL", "MO", "SC", "NC", "OK", "ND",
]);

export const INTAKE_RULES = {
  minBeds: 2,
  minListPrice: 20_000,
  maxListPrice: 400_000,
} as const;

/** Optional upper bound on DOM to drop stale market noise. Unset → no cap.
 *  Listings older than this are rejected listed_date_too_old. */
const DISTRESS_DOM_CAP =
  process.env.DISTRESS_DOM_CAP && /^\d+$/.test(process.env.DISTRESS_DOM_CAP)
    ? Number(process.env.DISTRESS_DOM_CAP)
    : null;

export interface IntakeCandidate {
  /** Vendor-stable id for trace/dedup (e.g. ATTOM attomId). */
  sourceId: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** Raw vendor property-type string (normalized internally). */
  propertyType: string | null;
  beds: number | null;
  listPrice: number | null;
  /** ISO date the listing went active. */
  listedDate: string | null;
  /** Listing agent contact (RentCast listingAgent.*). Written to Airtable
   *  as-is — H2 phone normalization handles format variation. null when the
   *  vendor omits the field; never synthesized. */
  agentName: string | null;
  agentPhone: string | null;
  agentEmail: string | null;
  /** Listing office name (RentCast listingOffice.name). Carried for future
   *  use; not written to Airtable in v1 (no confirmed Brokerage_Name field). */
  brokerageName: string | null;
  /** Days the listing has been active (RentCast daysOnMarket). Optional — not
   *  every source provides it; the cron derives a fallback from listedDate.
   *  Phase-2 distress accept signal (DOM ≥ threshold). */
  daysOnMarket?: number | null;
  /** A price reduction was detected in the listing history (RentCast).
   *  Optional; defaults to false. Phase-2 distress accept signal. */
  priceReduced?: boolean;
  /** Structural facts carried from the vendor response when present —
   *  saves a per-record enrichment call (Station 2 ENRICH). Source-
   *  agnostic by design: ATTOM snapshot, RentCast listings, and any
   *  future feed populate the same slots. Optional / nullable; the
   *  intake-cron write skips them when absent. */
  squareFootage?: number | null;
  bathrooms?: number | null;
  yearBuilt?: number | null;
}

export type IntakeRejectReason =
  | "not_sfr"
  | "beds_below_min"
  | "list_price_out_of_band"
  | "list_price_missing"
  | "listed_date_missing"
  | "listed_date_too_old"
  | "excluded_state"
  | "state_missing";

export interface IntakeEvaluation {
  accept: boolean;
  reasons: IntakeRejectReason[];
}

const DAY_MS = 86_400_000;

/** Pure: days-on-market derived from an ISO listed date. Fallback for sources
 *  (or rows) lacking an explicit daysOnMarket. null when date is absent or
 *  unparseable. Never negative (a future-dated listing → 0). */
export function daysOnMarketFrom(
  listedDate: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!listedDate) return null;
  const t = Date.parse(listedDate);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** Pure: SFR detection across common vendor spellings. */
export function isSingleFamily(propertyType: string | null): boolean {
  if (!propertyType) return false;
  const t = propertyType.toLowerCase();
  // Accept SFR / single family / detached; reject condo/townhouse/multi/land.
  if (/condo|townhouse|town home|townhome|multi|duplex|triplex|fourplex|apartment|commercial|land|lot|mobile|manufactured/.test(t)) {
    return false;
  }
  return /sfr|single\s*family|single-family|residential \(nec\)|detached/.test(t);
}

/** Pure: evaluate one candidate against all intake rules. Collects ALL
 *  failing reasons (not short-circuit) so rejections are fully itemized. */
export function evaluateIntakeCandidate(
  c: IntakeCandidate,
  now: Date = new Date(),
): IntakeEvaluation {
  const reasons: IntakeRejectReason[] = [];

  if (!isSingleFamily(c.propertyType)) reasons.push("not_sfr");

  if (c.beds == null || c.beds < INTAKE_RULES.minBeds) reasons.push("beds_below_min");

  if (c.listPrice == null) {
    reasons.push("list_price_missing");
  } else if (c.listPrice < INTAKE_RULES.minListPrice || c.listPrice > INTAKE_RULES.maxListPrice) {
    reasons.push("list_price_out_of_band");
  }

  // No DOM lower floor — every active band listing fires regardless of age.
  // The optional DISTRESS_DOM_CAP upper bound is the ONLY date gate; when it
  // is unset (default), listed-date is not evaluated at all and a missing
  // date never blocks intake.
  if (DISTRESS_DOM_CAP != null) {
    if (!c.listedDate) {
      reasons.push("listed_date_missing");
    } else {
      const t = Date.parse(c.listedDate);
      if (Number.isNaN(t)) {
        reasons.push("listed_date_missing");
      } else if ((now.getTime() - t) / DAY_MS > DISTRESS_DOM_CAP) {
        reasons.push("listed_date_too_old");
      }
    }
  }

  if (!c.state) {
    reasons.push("state_missing");
  } else if (EXCLUDED_STATES.has(c.state.trim().toUpperCase())) {
    reasons.push("excluded_state");
  }

  return { accept: reasons.length === 0, reasons };
}

export interface IntakeFilterResult {
  accepted: IntakeCandidate[];
  rejected: Array<{ candidate: IntakeCandidate; reasons: IntakeRejectReason[] }>;
}

/** Pure: partition a candidate list into accepted / rejected-with-reasons. */
export function filterIntakeCandidates(
  candidates: IntakeCandidate[],
  now: Date = new Date(),
): IntakeFilterResult {
  const accepted: IntakeCandidate[] = [];
  const rejected: IntakeFilterResult["rejected"] = [];
  for (const c of candidates) {
    const ev = evaluateIntakeCandidate(c, now);
    if (ev.accept) accepted.push(c);
    else rejected.push({ candidate: c, reasons: ev.reasons });
  }
  return { accepted, rejected };
}

/** Pure: normalize an address for dedup comparison against existing
 *  Listings_V1 rows. Lowercase, collapse whitespace, strip punctuation. */
export function normalizeAddressKey(address: string | null): string {
  if (!address) return "";
  return address.toLowerCase().replace(/[.,#]/g, "").replace(/\s+/g, " ").trim();
}

// ── Listing-content filters (operate on Firecrawl-scraped portal text) ──
//
// Run AFTER the Firecrawl renovation-keyword check passes:
//   1. wholesaler_excluded (hard reject) — agent stated buyer-type pref
//   2. hasConditionSignal — one input to the Phase-2 multi-signal accept
//      (condition copy OR DOM ≥ threshold OR price cut). When NONE of the
//      three are present the listing is soft-reviewed, never hard-rejected.
//
// Word-boundary matching (NOT substring): "structural" matches, but
// "infrastructure" does not. The renovation filter (lib/.../firecrawl.ts)
// keeps its substring match unchanged — no regression.

export const WHOLESALER_EXCLUSION_KEYWORDS: readonly string[] = [
  "no wholesalers", "no wholesaler", "no wholesaling",
  "wholesalers need not", "wholesalers will not", "not for wholesalers",
  "end users only", "end-users only", "end user only", "end-user only",
  "owner occupants only", "owner-occupant only",
  "no investors", "investors need not", "not for investors",
  "no flippers", "no flipping",
  "principals only", "principal buyers only", "direct buyers only",
  "no assignments", "non-assignable", "not assignable",
  "no daisy chain", "no daisy chains",
];

export const DISTRESS_CONDITION_KEYWORDS: readonly string[] = [
  "as-is", "as is", "sold as-is", "sold as is",
  "handyman special", "handyman",
  "investor opportunity", "investor special",
  "fixer", "fixer-upper", "fixer upper",
  "needs work", "needs tlc", "tlc",
  "needs repairs", "needs repair", "needs updating", "needs updates",
  "foundation repair", "foundation issue",
  "structural", "structural issue",
  "cash only", "cash or hard money",
  "won't qualify for financing", "will not qualify",
  "estate sale", "probate", "inherited",
  "motivated seller", "must sell",
  "priced to sell", "bring offers",
  "any offer considered", "below market",
  "bring your contractor", "bring contractor",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pure: keywords whose WORD-BOUNDARY match appears in text (distinct, in
 *  list order). Case-insensitive. "structural" matches "structural issue"
 *  but NOT "infrastructure". */
export function matchKeywordsWordBoundary(
  text: string | null | undefined,
  keywords: readonly string[],
): string[] {
  if (!text) return [];
  return keywords.filter((k) => new RegExp(`\\b${escapeRegex(k)}\\b`, "i").test(text));
}

export interface ListingContentEvaluation {
  wholesalerExcluded: boolean;
  matchedWholesalerKeywords: string[];
  hasConditionSignal: boolean;
  matchedDistressKeywords: string[];
}

/** Pure: evaluate scraped portal text for wholesaler-exclusion +
 *  distress/condition signal. Caller applies the reject ordering
 *  (wholesaler first, then condition-missing). */
export function evaluateListingContent(text: string | null | undefined): ListingContentEvaluation {
  const matchedWholesalerKeywords = matchKeywordsWordBoundary(text, WHOLESALER_EXCLUSION_KEYWORDS);
  const matchedDistressKeywords = matchKeywordsWordBoundary(text, DISTRESS_CONDITION_KEYWORDS);
  return {
    wholesalerExcluded: matchedWholesalerKeywords.length > 0,
    matchedWholesalerKeywords,
    hasConditionSignal: matchedDistressKeywords.length > 0,
    matchedDistressKeywords,
  };
}
