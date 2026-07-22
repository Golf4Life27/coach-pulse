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

import { evaluateListingContent, extractScrapedSqft, crossCheckSqft, INTAKE_DISTRESS_DOM_MARK } from "@/lib/crawler/intake-filter";
import { scopeSubjectText, scopeStatusText } from "@/lib/crawler/sources/listing-text-scope";

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
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
  /** Building sqft stated on the scraped listing page (lot sizes excluded),
   *  null when the page states none. Data armor (operator 2026-07-03): the
   *  classify step cross-checks this against the RentCast candidate's sqft —
   *  the Tiger Flowers basement-double-count class (source 2× the real GLA
   *  → inflated seed ARV → overshot opener). Optional so existing result
   *  literals/tests stay valid; absent ⇒ fail open. */
  scrapedSqft?: number | null;
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

/** Pure: turn a scraped listing's markdown into the classified verify
 *  result. Shared by verifyListing (search→scrape) and any future
 *  scrape-known-URL path. `formattedAddress` is used for a post-scrape
 *  street-number confirmation: if the scraped page doesn't carry the
 *  subject's street number we treat it as unresolved rather than
 *  classifying the wrong page (this preserves the match accuracy the old
 *  scrape-all-5-then-pick gave us, now that we pick BEFORE scraping). */
export function buildResolvedResult(
  markdown: string,
  url: string | null,
  formattedAddress: string | null,
  creditsUsed: number,
  debug: boolean,
): FirecrawlVerifyResult {
  const base: FirecrawlVerifyResult = {
    credentialed: true,
    resolved: false,
    url,
    stillActive: false,
    hasRenovatedLanguage: false,
    matchedKeywords: [],
    wholesalerExcluded: false,
    matchedWholesalerKeywords: [],
    hasConditionSignal: false,
    matchedDistressKeywords: [],
    isNewConstruction: false,
    matchedNewConstructionSignals: [],
    matchedInactiveMarkers: [],
    portfolioSellerDetected: false,
    matchedPortfolioKeywords: [],
    creditsUsed,
    rateLimited: false,
    paymentRequired: false,
    error: null,
  };
  const streetNum = (formattedAddress ?? "").trim().match(/^\d+/)?.[0] ?? null;
  if (streetNum && !markdown.toLowerCase().includes(streetNum)) {
    // Scraped page doesn't match the subject → don't classify a wrong listing.
    return { ...base, resolved: false };
  }
  const subjectText = scopeSubjectText(markdown);
  const statusText = scopeStatusText(markdown);
  const reno = detectRenovationLanguage(subjectText);
  const content = evaluateListingContent(subjectText);
  const newConstruction = detectNewConstruction(subjectText);
  const inactiveMarkers = detectInactiveMarkers(statusText);
  return {
    ...base,
    resolved: true,
    stillActive: inactiveMarkers.length === 0,
    hasRenovatedLanguage: reno.matched,
    matchedKeywords: reno.matchedKeywords,
    wholesalerExcluded: content.wholesalerExcluded,
    matchedWholesalerKeywords: content.matchedWholesalerKeywords,
    hasConditionSignal: content.hasConditionSignal,
    matchedDistressKeywords: content.matchedDistressKeywords,
    scrapedSqft: extractScrapedSqft(subjectText),
    isNewConstruction: newConstruction.isNew,
    matchedNewConstructionSignals: newConstruction.signals,
    matchedInactiveMarkers: inactiveMarkers,
    portfolioSellerDetected: content.portfolioSellerDetected,
    matchedPortfolioKeywords: content.matchedPortfolioKeywords,
    ...(debug
      ? {
          pageExcerpt: markdown.replace(/\s+/g, " ").trim().slice(0, PAGE_EXCERPT_CHARS),
          debugContexts: [
            ...buildDebugContexts(subjectText, [
              { category: "new_construction", phrases: newConstruction.isNew ? ["new construction"] : [] },
              { category: "renovation", phrases: reno.matchedKeywords },
              { category: "wholesaler", phrases: content.matchedWholesalerKeywords },
              { category: "distress", phrases: content.matchedDistressKeywords },
              { category: "portfolio", phrases: content.matchedPortfolioKeywords },
            ]),
            ...buildDebugContexts(statusText, [
              { category: "inactive", phrases: inactiveMarkers },
            ]),
          ],
        }
      : {}),
  };
}

/** Verify one candidate: SEARCH (URLs only, no inline scrape) → pick the
 *  best listing URL from metadata → SCRAPE that ONE page.
 *
 *  CREDIT REWORK (operator 2026-06-08): the old path called /v2/search
 *  with inline scrapeOptions, which scraped ALL `SEARCH_LIMIT` (5) results
 *  and used 1 — ~6 credits/candidate, and the dominant Firecrawl burn
 *  (97.5% /search). RentCast supplies no listing URL, so we still SEARCH
 *  to discover it — but with NO scrapeOptions (URLs only, ~1 credit), then
 *  /scrape only the single picked URL (~1 credit). ~2 credits/candidate,
 *  a ~67% cut, with accuracy preserved by picking on url/title pre-scrape
 *  and confirming the street number in the scraped markdown post-scrape.
 *  Throws are caught → error field. */
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
  // Map a Firecrawl HTTP status to an early-return verify result (shared by
  // the search and scrape legs — a 402/429 on either halts the candidate).
  const httpFail = async (res: Response, leg: "search" | "scrape", credits: number): Promise<FirecrawlVerifyResult> => {
    if (res.status === 429) return { ...base, creditsUsed: credits, rateLimited: true, error: `Firecrawl ${leg} 429 after retries exhausted` };
    if (res.status === 402) {
      // Payment Required — wallet empty. Flag distinctly so the caller keeps
      // the ZIP DUE + fires the CRITICAL alert instead of silently no-opping.
      return { ...base, creditsUsed: credits, paymentRequired: true, error: `Firecrawl ${leg} 402 Payment Required: ${await res.text().catch(() => "")}`.slice(0, 300) };
    }
    return { ...base, creditsUsed: credits, error: `Firecrawl ${leg} ${res.status}: ${await res.text().catch(() => "")}`.slice(0, 300) };
  };

  try {
    // ── Leg 1: SEARCH (URLs only, NO inline scrape) — ~1 credit. ──
    const { response: searchRes } = await fetchWithBackoff({
      doFetch: () =>
        fetch(FIRECRAWL_SEARCH_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: buildSearchQuery(formattedAddress), limit: SEARCH_LIMIT }),
          cache: "no-store",
        }),
    });
    if (searchRes.status !== 200 && !searchRes.ok) return httpFail(searchRes, "search", 0);
    const searchBody = (await searchRes.json()) as { data?: { web?: WebResult[] }; creditsUsed?: number };
    const searchCredits = typeof searchBody.creditsUsed === "number" ? searchBody.creditsUsed : 0;

    // Pick the best listing URL from metadata (url/title) — no markdown yet.
    const pick = pickListingResult(searchBody.data?.web ?? [], formattedAddress);
    if (!pick || !pick.url) {
      return { ...base, creditsUsed: searchCredits, resolved: false };
    }

    // ── Leg 2: SCRAPE the ONE picked URL — ~1 credit. ──
    const { response: scrapeRes } = await fetchWithBackoff({
      doFetch: () =>
        fetch(FIRECRAWL_SCRAPE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url: pick.url, formats: [{ type: "markdown" }] }),
          cache: "no-store",
        }),
    });
    if (scrapeRes.status !== 200 && !scrapeRes.ok) return httpFail(scrapeRes, "scrape", searchCredits);
    const scrapeBody = (await scrapeRes.json()) as { data?: { markdown?: string }; creditsUsed?: number };
    const scrapeCredits = typeof scrapeBody.creditsUsed === "number" ? scrapeBody.creditsUsed : 0;
    const markdown = scrapeBody.data?.markdown;
    const totalCredits = searchCredits + scrapeCredits;
    if (!markdown) {
      return { ...base, creditsUsed: totalCredits, url: pick.url ?? null, resolved: false };
    }

    return buildResolvedResult(markdown, pick.url ?? null, formattedAddress, totalCredits, opts.debug ?? false);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Freshness re-verify of a KNOWN listing URL — ONE /v2/scrape, ~1 credit
 *  (operator 2026-06-08, item 1). Skips the discovery /search entirely: once
 *  a property's URL is cached (Verification_URL), re-confirming it's still
 *  on-market is a single scrape, not a 2-credit search-then-scrape. Same
 *  classify path (buildResolvedResult) + the same street-number post-scrape
 *  confirmation. Used by the freshness re-verify pass to keep the
 *  outreach-eligible set "live within 24-48h" cheaply. */
export async function verifyListingByUrl(
  knownUrl: string | null,
  formattedAddress: string | null,
  opts: { debug?: boolean } = {},
): Promise<FirecrawlVerifyResult> {
  const base: FirecrawlVerifyResult = {
    credentialed: true,
    resolved: false,
    url: knownUrl,
    stillActive: false,
    hasRenovatedLanguage: false,
    matchedKeywords: [],
    wholesalerExcluded: false,
    matchedWholesalerKeywords: [],
    hasConditionSignal: false,
    matchedDistressKeywords: [],
    isNewConstruction: false,
    matchedNewConstructionSignals: [],
    matchedInactiveMarkers: [],
    portfolioSellerDetected: false,
    matchedPortfolioKeywords: [],
    creditsUsed: 0,
    rateLimited: false,
    paymentRequired: false,
    error: null,
  };
  if (!FIRECRAWL_API_KEY) return { ...base, credentialed: false, error: "FIRECRAWL_API_KEY not set" };
  if (!knownUrl) return { ...base, resolved: false, error: "no known url" };
  try {
    const { response: scrapeRes } = await fetchWithBackoff({
      doFetch: () =>
        fetch(FIRECRAWL_SCRAPE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url: knownUrl, formats: [{ type: "markdown" }] }),
          cache: "no-store",
        }),
    });
    if (scrapeRes.status !== 200 && !scrapeRes.ok) {
      if (scrapeRes.status === 429) return { ...base, rateLimited: true, error: "Firecrawl scrape 429 after retries" };
      if (scrapeRes.status === 402) return { ...base, paymentRequired: true, error: "Firecrawl scrape 402 Payment Required" };
      return { ...base, error: `Firecrawl scrape ${scrapeRes.status}` };
    }
    const body = (await scrapeRes.json()) as { data?: { markdown?: string }; creditsUsed?: number };
    const credits = typeof body.creditsUsed === "number" ? body.creditsUsed : 0;
    const markdown = body.data?.markdown;
    if (!markdown) return { ...base, creditsUsed: credits, resolved: false };
    return buildResolvedResult(markdown, knownUrl, formattedAddress, credits, opts.debug ?? false);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Verified-listing classification (pure; testable decision logic) ─────
//
// Precedence (top to bottom). Veto tier locked by operator amendment
// 2026-05-27 (Spine rec6DhIgAIH50jkJT); distress-accept tier restored BELOW
// the vetoes by operator ruling 2026-07-22 ("they need to be distressed in
// some fashion, either by DOM or physically"):
//   1. infra errors / unresolved → reject (no usable page)
//   2. inactive → reject
//   3. NEW CONSTRUCTION → reject   ── HARD VETO
//   4. wholesaler-excluded → reject
//   5. RENOVATION language → reject   ── HARD VETO (same tier as #3)
//   6. sqft cross-check mismatch → REVIEW (data armor before any accept)
//   7. text condition signal → ACCEPT (physical distress / as-is copy)
//   8. price cut OR aged DOM (≥ INTAKE_DISTRESS_DOM_MARK) → ACCEPT
//   9. else → SOFT "review" (writes Outreach_Status="Review" for spot-check).
//
// new_construction and renovation are the SAME hard-veto tier: a low cash
// offer on a turnkey / new build is always wrong, so NOTHING rescues them.
// The original Phase-2 bug let DOM/price-cut OVERRIDE a renovation match —
// it false-accepted 1138 Santa Anna (fully-remodeled turnkey, "remodeled" +
// priceReduced + DOM 177) which got texted in the first live H2 fire. The
// 2026-05-27 fix removed the override but OVER-CORRECTED: it demoted DOM /
// price-cut to diagnostic-only everywhere, so clean-copy aged listings
// piled into Review purgatory (138 in the week of 2026-07-15 alone) and
// first-touch supply starved at ~2/day. Tier 8 restores them as accept
// triggers STRICTLY BELOW the vetoes — Santa Anna still rejects at tier 5
// before DOM is ever consulted; the regression test pins this.

/** Candidate-side signals (from RentCast). Consulted at tier 8 (accept on
 *  price cut / aged DOM) — AFTER every hard veto, never an override
 *  (operator ruling 2026-07-22; Santa Anna guard preserved). */
export interface ListingDistressSignals {
  daysOnMarket: number | null;
  priceReduced: boolean;
}

/** Why an accept accepted — audit/log provenance for the funnel report. */
export type AcceptBasis = "condition_signal" | "price_cut" | "aged_dom";

export type VerifiedOutcome =
  | { outcome: "reject"; reason: string }
  | { outcome: "accept"; outreachStatus: ""; acceptBasis: AcceptBasis }
  | {
      outcome: "review";
      reason: "condition_signal_missing_flagged" | "sqft_mismatch_flagged";
      outreachStatus: "Review";
    };

export function classifyVerifiedListing(
  fc: FirecrawlVerifyResult,
  // Tier-8 distress-accept inputs (operator ruling 2026-07-22). Consulted
  // ONLY after every hard veto has passed — see precedence note above.
  signals: ListingDistressSignals = { daysOnMarket: null, priceReduced: false },
  // Data armor (operator 2026-07-03): the RentCast candidate's sqft, cross-
  // checked against the scraped page's stated sqft. Optional — absent, or
  // page states no sqft, behaves exactly as before (fail open).
  // domMark: aged-DOM accept bar; defaults to the shared intake knob.
  opts: { sourceSqft?: number | null; domMark?: number } = {},
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
  // ── SQFT CROSS-CHECK (data armor, 2026-07-03 Tiger Flowers defect):
  // source sqft ≥25% off the page's stated sqft ⇒ the value basis is
  // untrustworthy — Review BEFORE the distress accept (a genuinely
  // distressed listing with a lying sqft still prices wrong). Review, not
  // reject: the deal may be real; the DATA needs a human eye first.
  const sqft = crossCheckSqft(opts.sourceSqft, fc.scrapedSqft);
  if (sqft.mismatch) {
    return { outcome: "review", reason: "sqft_mismatch_flagged", outreachStatus: "Review" };
  }
  // ── Distress accepts (every hard veto already passed above) ──
  // Tier 7: physical distress / motivation in the listing copy.
  if (fc.hasConditionSignal) return { outcome: "accept", outreachStatus: "", acceptBasis: "condition_signal" };
  // Tier 8 (operator ruling 2026-07-22): a price capitulation or aged DOM is
  // distress too. Strictly below the vetoes — this can never resurrect the
  // Santa Anna override (a renovated/turnkey page rejected at tier 5).
  if (signals.priceReduced === true) return { outcome: "accept", outreachStatus: "", acceptBasis: "price_cut" };
  const domMark = opts.domMark ?? INTAKE_DISTRESS_DOM_MARK;
  if (signals.daysOnMarket != null && signals.daysOnMarket >= domMark) {
    return { outcome: "accept", outreachStatus: "", acceptBasis: "aged_dom" };
  }
  return { outcome: "review", reason: "condition_signal_missing_flagged", outreachStatus: "Review" };
}
