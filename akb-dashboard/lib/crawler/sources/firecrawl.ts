// Firecrawl listing-verification source (INV-028, merged into Crawler ship).
// @agent: scout
//
// RentCast returns ZERO free-text (no description/remarks) — a keyword
// filter on RentCast alone is a no-op. Renovation language lives on the
// listing portal page (Zillow/Redfin/MLS). Firecrawl reads it.
//
// Resolution + scrape in ONE call via Firecrawl /v2/search with inline
// scrapeOptions: query the address → top web results come back with
// markdown. RentCast has no listing URL and there's no reliable
// deterministic address→URL pattern (portal URLs carry an opaque listing
// id), so search-by-address is the reliable path — far better than
// guessing Redfin/Zillow slugs that 404 to a search page.
//
// Firecrawl API (confirmed 2026-05-25):
//   POST https://api.firecrawl.dev/v2/search
//   Authorization: Bearer FIRECRAWL_API_KEY
//   body { query, limit, scrapeOptions: { formats: [{ type: "markdown" }] } }
//   → { success, data: { web: [{ url, title, description, markdown }] }, creditsUsed }
//
// ⚠️ FIRECRAWL_API_KEY must be set in prod env (operator action) — the
// adapter returns credentialed=false when absent.

import { evaluateListingContent } from "@/lib/crawler/intake-filter";
import { scopeSubjectText, scopeStatusText } from "@/lib/crawler/sources/listing-text-scope";

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const FIRECRAWL_CREDIT_URL = "https://api.firecrawl.dev/v2/team/credit-usage";
const SEARCH_LIMIT = 5;

/** Probe the REAL Firecrawl account balance (remaining credits), once per
 *  run. The internal credits_used counter sums per-call usage and reads 0
 *  when calls 402 — it never reflects the actual wallet. This hits the
 *  account's credit-usage endpoint for ground truth. Best-effort: returns
 *  null on any failure (unknown endpoint shape, network, auth) so a wrong
 *  guess degrades to "unknown" rather than throwing. The 402 detection on
 *  the verify path is the hard guarantee; this is the supplementary gauge. */
export async function probeFirecrawlBalance(): Promise<{ remaining: number | null; error: string | null }> {
  if (!FIRECRAWL_API_KEY) return { remaining: null, error: "FIRECRAWL_API_KEY not set" };
  try {
    const res = await fetch(FIRECRAWL_CREDIT_URL, {
      headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
      cache: "no-store",
    });
    if (!res.ok) {
      return { remaining: null, error: `credit-usage ${res.status}` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    // Tolerate either {data:{remaining_credits}} or {remaining_credits} or
    // {data:{remainingCredits}} — Firecrawl has shifted this shape across
    // versions. Pull the first numeric "remaining" field we recognize.
    const data = (body.data as Record<string, unknown>) ?? body;
    const candidates = [
      data.remaining_credits,
      data.remainingCredits,
      data.remaining,
      (body as Record<string, unknown>).remaining_credits,
    ];
    const remaining = candidates.find((v) => typeof v === "number") as number | undefined;
    return { remaining: remaining ?? null, error: remaining == null ? "no recognized remaining-credits field" : null };
  } catch (err) {
    return { remaining: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Proactive throttle: max Firecrawl calls/minute. Default 90 stays under
 *  the free-tier 100/min cap with margin. The cron paces its loop to this. */
export const FIRECRAWL_RATE_LIMIT_PER_MINUTE = Number(
  process.env.FIRECRAWL_RATE_LIMIT_PER_MINUTE ?? "90",
);

/** Reactive backoff: retries on 429 before giving up. */
export const FIRECRAWL_MAX_RETRIES = Number(process.env.FIRECRAWL_MAX_RETRIES ?? "3");
const FIRECRAWL_BASE_BACKOFF_MS = 1000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Pure: parse a Retry-After header → ms. Supports delta-seconds and
 *  HTTP-date forms. Returns null when absent/unparseable. */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000; // delta-seconds
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now.getTime());
  return null;
}

/** Pure: delay before retry attempt N (0-indexed). Honors Retry-After when
 *  present, else exponential backoff (base * 2^attempt). */
export function computeRetryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  baseDelayMs: number = FIRECRAWL_BASE_BACKOFF_MS,
): number {
  if (retryAfterMs != null && retryAfterMs >= 0) return retryAfterMs;
  return baseDelayMs * Math.pow(2, attempt);
}

interface MinimalResponse {
  status: number;
  headers: { get(name: string): string | null };
}

export interface BackoffResult<R> {
  response: R;
  attempts: number; // total attempts made (1 = no retry)
  retried429: number; // how many 429s were retried
}

/** Retry a fetch on 429 with Retry-After / exponential backoff. doFetch +
 *  sleep are injected for testability. Returns the final response (which may
 *  still be 429 after exhausting retries — caller decides). */
export async function fetchWithBackoff<R extends MinimalResponse>(opts: {
  doFetch: () => Promise<R>;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseDelayMs?: number;
  now?: () => Date;
}): Promise<BackoffResult<R>> {
  const sleep = opts.sleep ?? realSleep;
  const maxRetries = opts.maxRetries ?? FIRECRAWL_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? FIRECRAWL_BASE_BACKOFF_MS;
  const now = opts.now ?? (() => new Date());

  let attempts = 0;
  let retried429 = 0;
  let response = await opts.doFetch();
  attempts++;

  while (response.status === 429 && retried429 < maxRetries) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), now());
    await sleep(computeRetryDelayMs(retried429, retryAfterMs, baseDelayMs));
    retried429++;
    response = await opts.doFetch();
    attempts++;
  }
  return { response, attempts, retried429 };
}


/** Renovation / turnkey exclusion keywords. Exported CONST so the operator
 *  can tune without a deploy (edit + redeploy is still needed for code, but
 *  this is the single source of truth). Matched case-insensitively as
 *  substrings against the full scraped page text. */
export const RENOVATION_EXCLUSION_KEYWORDS: readonly string[] = [
  "fully renovated", "completely renovated", "newly renovated", "just renovated", "renovated",
  "turnkey", "turn-key", "turn key",
  "move-in ready", "move in ready",
  "fully updated", "completely updated", "newly updated",
  "fully remodeled", "completely remodeled", "newly remodeled", "remodeled",
  "new construction", "new build", "newly built",
  "fully rehabbed", "rehab complete", "rehabbed",
  "everything new", "all new", "new kitchen and bath",
];

/** Portal domains we trust as listing-detail pages, ranked. */
const PREFERRED_DOMAINS = ["redfin.com", "zillow.com", "realtor.com", "homes.com", "trulia.com"];

/** Inactive-status markers — portal text that means THIS listing is no
 *  longer actively for sale. RentCast is the authoritative Active source;
 *  this is only a staleness double-check, so the bar for overriding it is
 *  HIGH. Only unambiguous "this listing was removed" phrasings belong here.
 *
 *  Deliberately EXCLUDED (2026-05-26 regression fix): "off market" /
 *  "off-market" / "sale pending" / "sold on" / "this home sold" — these
 *  appear in Zillow/Redfin nearby-homes, recently-sold, and pending-comps
 *  boilerplate on pages whose subject listing is still active, and a
 *  full-page substring scan false-flags them as inactive (dropped 3 live
 *  distress listings, e.g. 3719 W Houston). */
const INACTIVE_MARKERS = [
  "no longer available", "listing removed", "no longer on the market",
];

export interface FirecrawlVerifyResult {
  credentialed: boolean;
  resolved: boolean;
  url: string | null;
  stillActive: boolean;
  hasRenovatedLanguage: boolean;
  matchedKeywords: string[];
  /** Listing-content checks on the scraped page text (run after renovation):
   *  wholesalerExcluded = agent stated buyer-type preference (hard reject);
   *  hasConditionSignal = page affirmatively shows distress/motivation/as-is
   *  (absence → condition_signal_missing hard reject). */
  wholesalerExcluded: boolean;
  matchedWholesalerKeywords: string[];
  hasConditionSignal: boolean;
  matchedDistressKeywords: string[];
  /** ACTUAL new construction — a HARD exclusion above the distress override
   *  (classify → new_construction_excluded). */
  isNewConstruction: boolean;
  matchedNewConstructionSignals: string[];
  /** Matched inactive markers (the phrases behind stillActive=false). */
  matchedInactiveMarkers: string[];
  /** Portfolio / investor-seller language (operator 2026-06-08). DOWN-RANK
   *  signal — NOT a veto. False when distress overrides (motivated wins).
   *  H2 cadence consumes this to deprioritize portfolio sellers in the
   *  eligible band. Forward-only: applies to all new intake; no cohort
   *  backfill. */
  portfolioSellerDetected: boolean;
  matchedPortfolioKeywords: string[];
  creditsUsed: number;
  /** true when Firecrawl returned 429 even after exhausting retries —
   *  distinct from a generic error (caller → firecrawl_rate_limited). */
  rateLimited: boolean;
  /** true when Firecrawl returned 402 Payment Required — the wallet is
   *  empty (operator 2026-06-08). DISTINCT from a generic error: a 402
   *  means EVERY subsequent verify in this run will also fail, the ZIP
   *  did NO real work, and it must stay DUE for retry once credits refill.
   *  Also the trigger for the CRITICAL Pulse alert. */
  paymentRequired: boolean;
  error: string | null;
  /** Populated ONLY when verifyListing is called with { debug: true } — a
   *  first-N-char excerpt of the scraped page + per-matched-phrase context
   *  snippets. Investigation aid (INV ?debug=true); never used by filters. */
  pageExcerpt?: string | null;
  debugContexts?: Array<{ category: string; phrase: string; snippet: string }>;
}

const PAGE_EXCERPT_CHARS = 600;

/** Pure: assemble the per-matched-phrase context list for debug output. */
export function buildDebugContexts(
  markdown: string,
  groups: Array<{ category: string; phrases: string[] }>,
): Array<{ category: string; phrase: string; snippet: string }> {
  const out: Array<{ category: string; phrase: string; snippet: string }> = [];
  for (const g of groups) {
    for (const phrase of g.phrases) {
      const snippet = extractPhraseContext(markdown, phrase);
      if (snippet) out.push({ category: g.category, phrase, snippet });
    }
  }
  return out;
}

/** Pure: full-page text → matched renovation keywords (distinct, in list
 *  order). Substring, case-insensitive. */
export function detectRenovationLanguage(text: string | null | undefined): {
  matched: boolean;
  matchedKeywords: string[];
} {
  if (!text) return { matched: false, matchedKeywords: [] };
  const lc = text.toLowerCase();
  const hits = RENOVATION_EXCLUSION_KEYWORDS.filter((k) => lc.includes(k));
  return { matched: hits.length > 0, matchedKeywords: hits };
}

/** How recent a year_built counts as new construction. now.year - 2 → e.g.
 *  in 2026, anything built 2024+ is new. Operator-tunable without a deploy. */
export const NEW_CONSTRUCTION_MAX_AGE_YEARS = Number(
  process.env.NEW_CONSTRUCTION_MAX_AGE_YEARS ?? "2",
);

/** Pure: detect ACTUAL new construction from scraped portal text — a HARD
 *  exclusion (a 65%-of-list offer on a new build is wrong, and unlike the soft
 *  renovation bucket this must NOT be overridable by a distress signal). Three
 *  STRONG signals only (operator 2026-05-27; unit numbers deliberately NOT a
 *  signal — old duplexes/fourplexes carry them and are prime targets):
 *    • Zillow facts "New construction: Yes"
 *    • a "new construction" banner/label (Redfin). The ": No" facts form and
 *      the comps sidebar are stripped upstream (scopeSubjectText), so a
 *      surviving "new construction" here is the SUBJECT's own banner.
 *    • year_built within the last NEW_CONSTRUCTION_MAX_AGE_YEARS calendar years.
 *  Scan the SCOPED subject text, never the raw page. */
export function detectNewConstruction(
  text: string | null | undefined,
  now: Date = new Date(),
): { isNew: boolean; signals: string[] } {
  if (!text) return { isNew: false, signals: [] };
  const signals: string[] = [];
  if (/\bnew\s+construction\s*:\s*yes\b/i.test(text)) signals.push("new_construction_yes");
  else if (/\bnew construction\b/i.test(text)) signals.push("new_construction_banner");
  const cutoff = now.getFullYear() - NEW_CONSTRUCTION_MAX_AGE_YEARS;
  const yearMatch =
    text.match(/\byear\s+built\s*:?\s*(\d{4})/i) ?? text.match(/\bbuilt\s+in\s+(\d{4})/i);
  if (yearMatch) {
    const yr = Number(yearMatch[1]);
    if (yr >= cutoff && yr <= now.getFullYear() + 2) signals.push(`year_built_${yr}`);
  }
  return { isNew: signals.length > 0, signals };
}

/** Pure: matched inactive markers (distinct, in list order). Substring,
 *  case-insensitive. Surfaced for debug + Phase-2 rebalancing. */
export function detectInactiveMarkers(text: string | null | undefined): string[] {
  if (!text) return [];
  const lc = text.toLowerCase();
  return INACTIVE_MARKERS.filter((m) => lc.includes(m));
}

/** Pure: heuristic still-active check from portal text. Returns false only
 *  on a strong inactive marker. Default true (RentCast already said Active;
 *  this is a staleness double-check). */
export function detectStillActive(text: string | null | undefined): boolean {
  if (!text) return true; // no text → don't override RentCast's Active
  return detectInactiveMarkers(text).length === 0;
}

/** Pure: a context snippet around the FIRST case-insensitive occurrence of
 *  `phrase` in `text` (±`radius` chars, single-lined, ellipsised). null when
 *  the phrase is absent. Investigation aid — shows WHY a keyword matched. */
export function extractPhraseContext(
  text: string | null | undefined,
  phrase: string,
  radius = 80,
): string | null {
  if (!text || !phrase) return null;
  const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + phrase.length + radius);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
}

/** Pure: build the address search query. */
export function buildSearchQuery(formattedAddress: string | null): string {
  return `${(formattedAddress ?? "").trim()} for sale`.trim();
}

interface WebResult {
  url?: string;
  title?: string;
  description?: string;
  markdown?: string;
}

/** Pure: pick the best listing-detail result for a subject address. Prefers
 *  known portal domains, then requires the result to plausibly match the
 *  subject (street-number token present in url/title/markdown). null when
 *  nothing matches → caller surfaces firecrawl_url_unresolved. */
export function pickListingResult(
  web: WebResult[],
  formattedAddress: string | null,
): WebResult | null {
  if (!Array.isArray(web) || web.length === 0) return null;
  const streetNum = (formattedAddress ?? "").trim().match(/^\d+/)?.[0] ?? null;
  const matchesSubject = (r: WebResult): boolean => {
    if (!streetNum) return false;
    const hay = `${r.url ?? ""} ${r.title ?? ""} ${r.markdown?.slice(0, 2000) ?? ""}`.toLowerCase();
    return hay.includes(streetNum);
  };
  const candidates = web.filter(matchesSubject);
  const pool = candidates.length > 0 ? candidates : [];
  for (const domain of PREFERRED_DOMAINS) {
    const hit = pool.find((r) => (r.url ?? "").toLowerCase().includes(domain));
    if (hit) return hit;
  }
  return pool[0] ?? null;
}

/** Resolve + scrape + verify one candidate via Firecrawl search. One
 *  /v2/search call (inline scrape). Throws are caught → error field. */
export async function verifyListing(
  formattedAddress: string | null,
  opts: { debug?: boolean } = {},
): Promise<FirecrawlVerifyResult> {
  const base: FirecrawlVerifyResult = {
    credentialed: true,
    resolved: false,
    url: null,
    stillActive: false,
    hasRenovatedLanguage: false,
    matchedKeywords: [],
    wholesalerExcluded: false,
    matchedWholesalerKeywords: [],
    hasConditionSignal: false,
    matchedDistressKeywords: [],
    isNewConstruction: false,
    matchedNewConstructionSignals: [],
    portfolioSellerDetected: false,
    matchedPortfolioKeywords: [],
    matchedInactiveMarkers: [],
    creditsUsed: 0,
    rateLimited: false,
    paymentRequired: false,
    error: null,
  };
  if (!FIRECRAWL_API_KEY) {
    return { ...base, credentialed: false, error: "FIRECRAWL_API_KEY not set" };
  }
  try {
    // Retry 429s with Retry-After / exponential backoff before giving up.
    const { response: res } = await fetchWithBackoff({
      doFetch: () =>
        fetch(FIRECRAWL_SEARCH_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: buildSearchQuery(formattedAddress),
            limit: SEARCH_LIMIT,
            scrapeOptions: { formats: [{ type: "markdown" }] },
          }),
          cache: "no-store",
        }),
    });
    if (res.status === 429) {
      // Still rate-limited after exhausting retries — distinct signal.
      return { ...base, rateLimited: true, error: "Firecrawl 429 after retries exhausted" };
    }
    if (res.status === 402) {
      // Payment Required — wallet empty. Every other verify this run will
      // hit the same wall, so flag it distinctly: the caller keeps the ZIP
      // DUE and fires a CRITICAL alert instead of silently no-opping.
      return {
        ...base,
        paymentRequired: true,
        error: `Firecrawl 402 Payment Required: ${await res.text().catch(() => "")}`.slice(0, 300),
      };
    }
    if (!res.ok) {
      return { ...base, error: `Firecrawl search ${res.status}: ${await res.text().catch(() => "")}`.slice(0, 300) };
    }
    const body = (await res.json()) as {
      data?: { web?: WebResult[] };
      creditsUsed?: number;
    };
    const creditsUsed = typeof body.creditsUsed === "number" ? body.creditsUsed : 0;
    const pick = pickListingResult(body.data?.web ?? [], formattedAddress);
    if (!pick || !pick.markdown) {
      return { ...base, creditsUsed, resolved: false };
    }
    // Scope to the subject listing before keyword scanning: comps sidebar +
    // empty facts rows for renovation/content; comps + sale-history for the
    // inactive check. Raw cross-listing noise was the 0%-accept root cause.
    const subjectText = scopeSubjectText(pick.markdown);
    const statusText = scopeStatusText(pick.markdown);
    const reno = detectRenovationLanguage(subjectText);
    const content = evaluateListingContent(subjectText);
    const newConstruction = detectNewConstruction(subjectText);
    const inactiveMarkers = detectInactiveMarkers(statusText);
    return {
      credentialed: true,
      resolved: true,
      url: pick.url ?? null,
      stillActive: inactiveMarkers.length === 0,
      hasRenovatedLanguage: reno.matched,
      matchedKeywords: reno.matchedKeywords,
      wholesalerExcluded: content.wholesalerExcluded,
      matchedWholesalerKeywords: content.matchedWholesalerKeywords,
      hasConditionSignal: content.hasConditionSignal,
      matchedDistressKeywords: content.matchedDistressKeywords,
      isNewConstruction: newConstruction.isNew,
      matchedNewConstructionSignals: newConstruction.signals,
      matchedInactiveMarkers: inactiveMarkers,
      portfolioSellerDetected: content.portfolioSellerDetected,
      matchedPortfolioKeywords: content.matchedPortfolioKeywords,
      creditsUsed,
      rateLimited: false,
      paymentRequired: false,
      error: null,
      ...(opts.debug
        ? {
            // pageExcerpt stays RAW (shows what Firecrawl actually scraped);
            // contexts come from the SCOPED text each category was scanned
            // against, so a snippet reflects the real match site.
            pageExcerpt: pick.markdown.replace(/\s+/g, " ").trim().slice(0, PAGE_EXCERPT_CHARS),
            debugContexts: [
              ...buildDebugContexts(subjectText, [
                { category: "new_construction", phrases: newConstruction.isNew ? ["new construction"] : [] },
                { category: "renovation", phrases: reno.matchedKeywords },
                { category: "wholesaler", phrases: content.matchedWholesalerKeywords },
                { category: "distress", phrases: content.matchedDistressKeywords },
              ]),
              ...buildDebugContexts(statusText, [
                { category: "inactive", phrases: inactiveMarkers },
              ]),
            ],
          }
        : {}),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Verified-listing classification (pure; testable decision logic) ─────
//
// Precedence (top to bottom), locked by operator amendment 2026-05-27
// (Spine rec6DhIgAIH50jkJT):
//   1. infra errors / unresolved → reject (no usable page)
//   2. inactive → reject
//   3. NEW CONSTRUCTION → reject   ── HARD VETO
//   4. wholesaler-excluded → reject
//   5. RENOVATION language → reject   ── HARD VETO (same tier as #3)
//   6. text condition signal → ACCEPT (genuine distress / motivation / as-is)
//   7. else → SOFT "review" (writes Outreach_Status="Review" for spot-check).
//
// new_construction and renovation are the SAME hard-veto tier: a 65%-of-list
// cash offer on a turnkey / new build is always wrong, so NOTHING rescues
// them. The earlier Phase-2 "multi-signal accept" (PR #10/#11) let DOM ≥ N or
// a price cut OVERRIDE a renovation match — that override is REMOVED here. It
// false-accepted 1138 Santa Anna (a fully-remodeled turnkey, "remodeled" +
// priceReduced + DOM 177) which then got texted in the first live H2 fire.
// The asymmetry is the whole reason: a false-reject of a maybe-distress
// listing is recoverable; a false-accept of a turnkey wastes the offer and
// damages the brand in a launch market.
//
// DOM / priceReduced (ListingDistressSignals) are DIAGNOSTIC ONLY now — the
// cron still surfaces them for audit / review routing, but they are NEVER an
// accept trigger and NEVER override a hard veto.

/** Candidate-side signals (from RentCast). DIAGNOSTIC ONLY as of the
 *  2026-05-27 amendment — surfaced for audit, never an accept trigger and
 *  never an override of the renovation / new_construction hard vetoes. */
export interface ListingDistressSignals {
  daysOnMarket: number | null;
  priceReduced: boolean;
}

export type VerifiedOutcome =
  | { outcome: "reject"; reason: string }
  | { outcome: "accept"; outreachStatus: "" }
  | { outcome: "review"; reason: "condition_signal_missing_flagged"; outreachStatus: "Review" };

export function classifyVerifiedListing(
  fc: FirecrawlVerifyResult,
  // Retained on the signature for audit parity and to regression-guard the
  // removed override; deliberately NOT consulted (see precedence note above).
  _signals: ListingDistressSignals = { daysOnMarket: null, priceReduced: false },
): VerifiedOutcome {
  if (!fc.credentialed) return { outcome: "reject", reason: "firecrawl_not_configured" };
  if (fc.paymentRequired) return { outcome: "reject", reason: "firecrawl_payment_required" };
  if (fc.rateLimited) return { outcome: "reject", reason: "firecrawl_rate_limited" };
  if (fc.error) return { outcome: "reject", reason: "firecrawl_error" };
  if (!fc.resolved) return { outcome: "reject", reason: "firecrawl_url_unresolved" };
  if (!fc.stillActive) return { outcome: "reject", reason: "firecrawl_inactive" };
  // ── HARD-VETO tier — new_construction and renovation, no override of any
  //    kind (operator amendment 2026-05-27, Spine rec6DhIgAIH50jkJT).
  if (fc.isNewConstruction) return { outcome: "reject", reason: "new_construction_excluded" };
  if (fc.wholesalerExcluded) return { outcome: "reject", reason: "wholesaler_excluded" };
  if (fc.hasRenovatedLanguage) return { outcome: "reject", reason: "firecrawl_renovated" };
  // ── Distress accept: a genuine condition/motivation signal in the copy.
  if (fc.hasConditionSignal) return { outcome: "accept", outreachStatus: "" };
  return { outcome: "review", reason: "condition_signal_missing_flagged", outreachStatus: "Review" };
}
