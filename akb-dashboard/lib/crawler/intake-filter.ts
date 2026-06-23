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

import { isPriceableMarket } from "@/lib/markets/actionable";

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

// ── Conversion-era pre-filter tightening (operator 2026-06-08, item 1d).
// Both DEFAULT OFF so they don't silently reverse the "fire on every active
// band listing" policy — the operator opts in to cut Firecrawl scrape
// volume when conversion (not lead-gen) is the constraint.
//
// INTAKE_DOM_FLOOR: reject candidates with daysOnMarket < N (too fresh to
//   be motivated). Unset → no floor.
const INTAKE_DOM_FLOOR =
  process.env.INTAKE_DOM_FLOOR && /^\d+$/.test(process.env.INTAKE_DOM_FLOOR)
    ? Number(process.env.INTAKE_DOM_FLOOR)
    : null;
// INTAKE_REQUIRE_DISTRESS: reject a candidate carrying NO distress signal (no
//   price reduction AND DOM below the distress-DOM mark). DEFAULT ON (operator
//   2026-06-22) — the funnel sources distress, not market-rate active listings;
//   the 17→2 census proved the spread term was masking that. Set ="false" to
//   restore the old fire-on-everything behavior.
const INTAKE_REQUIRE_DISTRESS = process.env.INTAKE_REQUIRE_DISTRESS !== "false";
// INTAKE_DISTRESS_DOM_MARK: the aged-DOM bar. DEFAULT 90 (operator 2026-06-22)
//   to align with A1's distress threshold (DOM/30 ≥ 3 ⇒ DOM ≥ 90) so intake
//   doesn't source aged-but-sub-90 listings the distress score then rejects.
const INTAKE_DISTRESS_DOM_MARK =
  process.env.INTAKE_DISTRESS_DOM_MARK && /^\d+$/.test(process.env.INTAKE_DISTRESS_DOM_MARK)
    ? Number(process.env.INTAKE_DISTRESS_DOM_MARK)
    : 90;

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
  | "state_missing"
  | "dom_below_floor"
  | "no_distress_signal"
  | "market_not_priceable";

export interface IntakeEvaluation {
  accept: boolean;
  reasons: IntakeRejectReason[];
}

/** Optional priceability context. When requirePriceable is set, intake only
 *  accepts candidates in a PRICEABLE market (sourced arv_pct_max + a seeded
 *  ZIP buyer-median) — so we never scrape/verify a market we can't make an
 *  MAO-checked offer in (e.g. TX: San Antonio / Dallas / Houston). The cron
 *  loads seededZips once (lib/buyer-median-store.listSeededZips) and passes
 *  it; pure callers that omit it keep the legacy state-only gate. */
export interface IntakePriceabilityOpts {
  seededZips?: ReadonlySet<string>;
  requirePriceable?: boolean;
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

export interface DistressSourcingConfig {
  /** Require a distress signal (aged DOM OR price cut) to source. */
  requireDistress: boolean;
  /** The aged-DOM bar (DOM ≥ domMark counts as distressed). */
  domMark: number;
  /** Optional hard DOM floor (reject DOM < domFloor). */
  domFloor: number | null;
}

/** The module-default distress-sourcing config (operator 2026-06-22: ON, ≥90,
 *  no separate floor). Overridable per-call so the rule is unit-testable
 *  without env-stubbing. */
export const DEFAULT_DISTRESS_SOURCING: DistressSourcingConfig = {
  requireDistress: INTAKE_REQUIRE_DISTRESS,
  domMark: INTAKE_DISTRESS_DOM_MARK,
  domFloor: INTAKE_DOM_FLOOR,
};

/** Pure: the Phase-1 distress-sourcing reasons. A candidate is sourced only on
 *  a price cut OR an aged DOM (≥ domMark). DOM resolves from the explicit
 *  daysOnMarket, falling back to the listedDate derivation. */
export function distressSourcingReasons(
  c: { daysOnMarket?: number | null; listedDate?: string | null; priceReduced?: boolean },
  cfg: DistressSourcingConfig = DEFAULT_DISTRESS_SOURCING,
  now: Date = new Date(),
): IntakeRejectReason[] {
  const reasons: IntakeRejectReason[] = [];
  const dom = c.daysOnMarket ?? daysOnMarketFrom(c.listedDate ?? null, now);
  if (cfg.domFloor != null && dom != null && dom < cfg.domFloor) reasons.push("dom_below_floor");
  if (cfg.requireDistress) {
    const hasPriceCut = c.priceReduced === true;
    const hasAgedDom = dom != null && dom >= cfg.domMark;
    if (!hasPriceCut && !hasAgedDom) reasons.push("no_distress_signal");
  }
  return reasons;
}

/** Pure: evaluate one candidate against all intake rules. Collects ALL
 *  failing reasons (not short-circuit) so rejections are fully itemized. */
export function evaluateIntakeCandidate(
  c: IntakeCandidate,
  now: Date = new Date(),
  priceability: IntakePriceabilityOpts = {},
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
  } else if (priceability.requirePriceable) {
    // Tighten to PRICEABLE markets only — don't scrape/verify a market we
    // can't price (sourced arv_pct_max + a seeded ZIP buyer-median).
    const verdict = isPriceableMarket(
      { state: c.state, city: c.city, zip: c.zip },
      priceability.seededZips ?? new Set<string>(),
    );
    if (!verdict.actionable) reasons.push("market_not_priceable");
  }

  // ── Phase-1 distress sourcing (operator 2026-06-22; default ON, DOM ≥ 90) ──
  // Source distress, not market-rate active listings: accept only a price cut
  // OR an aged DOM. Pure + config-injectable for tests; the live path uses the
  // module defaults.
  reasons.push(...distressSourcingReasons(c, DEFAULT_DISTRESS_SOURCING, now));

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
  priceability: IntakePriceabilityOpts = {},
): IntakeFilterResult {
  const accepted: IntakeCandidate[] = [];
  const rejected: IntakeFilterResult["rejected"] = [];
  for (const c of candidates) {
    const ev = evaluateIntakeCandidate(c, now, priceability);
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

/** Portfolio / multi-property language (operator 2026-06-08, NARROWED).
 *  Forward-only DOWN-RANK signal (never a veto). Distress overrides.
 *
 *  NARROWING RATIONALE: the first cut also triggered on single-property
 *  occupancy status (tenant-occupied, rent-ready, turnkey rental). That
 *  catches MOTIVATED INDIVIDUAL LANDLORDS — the opposite of intent. So
 *  only EXPLICIT multi-property / package language triggers now. Occupancy
 *  and 1031/institutional are CO-FACTORS: they count only when they
 *  co-occur with actual package language, never alone.
 *
 *  Bare "package" is deliberately NOT a keyword — listings say "appliance
 *  package" / "upgrade package" constantly. Only property-bundle package
 *  forms ("package deal", "investment package") + the structured patterns
 *  below trigger. */
export const PORTFOLIO_PACKAGE_KEYWORDS: readonly string[] = [
  "portfolio",
  "package deal", "package sale", "investment package", "property package",
  "bulk sale", "bulk portfolio",
];

/** Structured multi-property phrasings (the operator's explicit examples:
 *  "offered individually or as a portfolio", "purchase all N together",
 *  "N single-family homes"). Each requires a count or the portfolio word,
 *  so a single-property listing can't trip them. */
export const PORTFOLIO_PACKAGE_PATTERNS: readonly RegExp[] = [
  /offered\s+(?:individually\s+)?(?:or\s+)?as\s+a\s+portfolio/i,
  /(?:purchase|buy|sold|available)\s+all\s+\d+\s+(?:together|as\s+a\s+package|properties|homes)/i,
  /\b[2-9]\d*\s+single[- ]family\s+homes\b/i,
  /\b\d+[- ]propert(?:y|ies)\s+(?:portfolio|package|bundle)/i,
  /\bmultiple\s+properties\s+(?:available|for\s+sale|in\s+this)/i,
];

/** Co-factors — occupancy + 1031/institutional. NOT standalone triggers.
 *  Counted (and reported) ONLY when package language is also present, so a
 *  single tenant-occupied house from a motivated landlord is never flagged. */
export const PORTFOLIO_COFACTOR_KEYWORDS: readonly string[] = [
  // occupancy
  "tenant occupied", "tenant-occupied",
  "currently rented", "currently leased",
  "rent ready", "rent-ready",
  "turnkey rental", "turn-key rental",
  "stabilized rental",
  // 1031 / institutional
  "1031 exchange", "1031-exchange",
  "institutional seller", "institutional owner",
  "reit divestment", "fund liquidation",
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

/** Pure: regex patterns that match the text (returns the matched substrings
 *  for surfacing in the audit note). */
export function matchPatterns(
  text: string | null | undefined,
  patterns: readonly RegExp[],
): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) hits.push(m[0].replace(/\s+/g, " ").trim().toLowerCase());
  }
  return hits;
}

export interface PortfolioEvaluation {
  /** Multi-property/package language detected (the only thing that fires
   *  the down-rank). FALSE when distress overrides. */
  detected: boolean;
  /** Package keywords + structured-pattern hits. */
  packageMatches: string[];
  /** Co-factor matches — only populated WHEN packageMatches is non-empty. */
  cofactorMatches: string[];
}

/** Pure: portfolio detection per the operator's narrowed rule. Package
 *  language is the sole trigger; co-factors enrich the match list ONLY
 *  when package language is present. Distress override is applied by the
 *  caller (evaluateListingContent). */
export function evaluatePortfolioSignal(text: string | null | undefined): PortfolioEvaluation {
  const packageKw = matchKeywordsWordBoundary(text, PORTFOLIO_PACKAGE_KEYWORDS);
  const packagePat = matchPatterns(text, PORTFOLIO_PACKAGE_PATTERNS);
  const packageMatches = [...packageKw, ...packagePat];
  const hasPackage = packageMatches.length > 0;
  // Co-factors count ONLY alongside real package language.
  const cofactorMatches = hasPackage
    ? matchKeywordsWordBoundary(text, PORTFOLIO_COFACTOR_KEYWORDS)
    : [];
  return { detected: hasPackage, packageMatches, cofactorMatches };
}

export interface ListingContentEvaluation {
  wholesalerExcluded: boolean;
  matchedWholesalerKeywords: string[];
  hasConditionSignal: boolean;
  matchedDistressKeywords: string[];
  /** Portfolio/investor-seller language detected (operator directive
   *  2026-06-08). FALSE when distress overrides — a portfolio motivated
   *  seller is still motivated. Consumers DOWN-RANK on this, never veto. */
  portfolioSellerDetected: boolean;
  matchedPortfolioKeywords: string[];
}

/** Pure: evaluate scraped portal text for wholesaler-exclusion +
 *  distress/condition signal + portfolio-seller signal. Caller applies
 *  the reject ordering (wholesaler first, then condition-missing). The
 *  portfolio flag is informational — H2 cadence reads it to deprioritize
 *  the candidate within the eligible band, never to reject. */
export function evaluateListingContent(text: string | null | undefined): ListingContentEvaluation {
  const matchedWholesalerKeywords = matchKeywordsWordBoundary(text, WHOLESALER_EXCLUSION_KEYWORDS);
  const matchedDistressKeywords = matchKeywordsWordBoundary(text, DISTRESS_CONDITION_KEYWORDS);
  const portfolio = evaluatePortfolioSignal(text);
  // matchedPortfolioKeywords = package hits + co-factors (co-factors only
  // present when package language fired). Reported for the audit note.
  const matchedPortfolioKeywords = [...portfolio.packageMatches, ...portfolio.cofactorMatches];
  // Distress overrides — a multi-property listing that ALSO carries
  // distress language is treated as a motivated portfolio (still high-prio).
  const portfolioSellerDetected = portfolio.detected && matchedDistressKeywords.length === 0;
  return {
    wholesalerExcluded: matchedWholesalerKeywords.length > 0,
    matchedWholesalerKeywords,
    hasConditionSignal: matchedDistressKeywords.length > 0,
    matchedDistressKeywords,
    portfolioSellerDetected,
    matchedPortfolioKeywords,
  };
}
