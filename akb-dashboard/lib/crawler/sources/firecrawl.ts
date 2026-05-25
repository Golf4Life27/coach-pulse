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

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const SEARCH_LIMIT = 5;

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

/** Inactive-status markers — portal text that means the listing is no
 *  longer actively for sale (catches RentCast staleness). Conservative set
 *  to avoid false-inactives; a false drop is acceptable (we just skip it). */
const INACTIVE_MARKERS = [
  "no longer available", "off market", "off-market", "sale pending", "sold on",
  "this home sold", "listing removed", "no longer on the market",
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
  creditsUsed: number;
  /** true when Firecrawl returned 429 even after exhausting retries —
   *  distinct from a generic error (caller → firecrawl_rate_limited). */
  rateLimited: boolean;
  error: string | null;
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

/** Pure: heuristic still-active check from portal text. Returns false only
 *  on a strong inactive marker. Default true (RentCast already said Active;
 *  this is a staleness double-check). */
export function detectStillActive(text: string | null | undefined): boolean {
  if (!text) return true; // no text → don't override RentCast's Active
  const lc = text.toLowerCase();
  return !INACTIVE_MARKERS.some((m) => lc.includes(m));
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
    creditsUsed: 0,
    rateLimited: false,
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
    const reno = detectRenovationLanguage(pick.markdown);
    const content = evaluateListingContent(pick.markdown);
    return {
      credentialed: true,
      resolved: true,
      url: pick.url ?? null,
      stillActive: detectStillActive(pick.markdown),
      hasRenovatedLanguage: reno.matched,
      matchedKeywords: reno.matchedKeywords,
      wholesalerExcluded: content.wholesalerExcluded,
      matchedWholesalerKeywords: content.matchedWholesalerKeywords,
      hasConditionSignal: content.hasConditionSignal,
      matchedDistressKeywords: content.matchedDistressKeywords,
      creditsUsed,
      rateLimited: false,
      error: null,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
