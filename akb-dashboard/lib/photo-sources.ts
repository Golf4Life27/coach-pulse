// Photo gathering for /api/photo-analysis.
//
// Four sources, tried in priority order, combined into a single array
// (max ~8 photos). Priority is "least scraping first" — APIs we already
// pay for and that return structured payloads are far preferable to
// scraping behind a bot wall:
//
//   1. RentCast structured photo URLs (via /properties or /listings/sale).
//      We already authenticate + pay; no bot wall, no robots.txt fight.
//   2. Firecrawl /v2/scrape (HTML format) — already wired for listing
//      verification, already paid. Returns the listing-page HTML with
//      Redfin CDN img URLs.
//   3. Raw Redfin scrape via ScraperAPI — legacy, last resort. Kept as
//      a fallback because ScraperAPI's render=true was returning HTTP
//      500 in prod 2026-06-04.
//   4. Google Street View Static API for the address. Exterior-only;
//      rehab vision must HOLD on Street-View-only / low-confidence —
//      do NOT pass on a weak exterior-only estimate.
//
// All four gracefully degrade to [] when their respective API keys are
// missing — the photo-analysis caller should treat an empty array as
// "no visual evidence" and warn rather than block.

import { getListingPhotosFromRentCast } from "@/lib/rentcast";

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

export interface CollectedPhoto {
  url: string;
  source: "rentcast" | "firecrawl" | "listing" | "streetview";
}

const REDFIN_PHOTO_RE = /https:\/\/[^"'\s]*?(?:ssl\.cdn-redfin|redfin)[^"'\s]*?\.jpg/gi;

/**
 * Scrape Redfin listing photos via ScraperAPI's HTML render endpoint.
 * Returns up to maxPhotos URLs; deduped.
 */
export async function scrapeListingPhotos(
  verificationUrl: string,
  maxPhotos = 5,
): Promise<string[]> {
  if (!SCRAPER_API_KEY || !verificationUrl || !verificationUrl.includes("redfin.com")) {
    return [];
  }
  const target = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(verificationUrl)}&render=true`;
  try {
    const res = await fetch(target, { cache: "no-store" });
    if (!res.ok) return [];
    const html = await res.text();
    const matches = html.match(REDFIN_PHOTO_RE) ?? [];
    const unique = Array.from(new Set(matches));
    // Prefer larger/full resolution URLs (Redfin often has _0.jpg, _1.jpg variants).
    return unique.slice(0, maxPhotos);
  } catch {
    return [];
  }
}

/**
 * Google Street View Static API. Returns a single URL for the address.
 * Requires GOOGLE_MAPS_API_KEY with Street View Static API enabled.
 */
export function streetViewUrl(
  fullAddress: string,
  size: { w: number; h: number } = { w: 800, h: 600 },
): string | null {
  if (!GOOGLE_MAPS_API_KEY || !fullAddress.trim()) return null;
  const params = new URLSearchParams({
    size: `${size.w}x${size.h}`,
    location: fullAddress,
    fov: "80",
    pitch: "0",
    key: GOOGLE_MAPS_API_KEY,
  });
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

/**
 * Diagnostic probe for the listing-photo scrape path. Unlike
 * scrapeListingPhotos (which swallows everything to []), this returns
 * the full breakdown so an operator can tell WHY a scrape came back
 * empty: missing key vs ScraperAPI error vs Redfin-HTML-change (HTML
 * returned but regex matched nothing) vs genuinely-photoless listing.
 *
 * Never throws — captures the failure into the result.
 */
export interface PhotoProbeResult {
  scraper_key_present: boolean;
  google_key_present: boolean;
  url_is_redfin: boolean;
  scraperapi_http_status: number | null;
  html_length: number | null;
  regex_match_count: number | null;
  sample_match: string | null;
  error: string | null;
}

export async function probeListingPhotos(
  verificationUrl: string | null,
): Promise<PhotoProbeResult> {
  const result: PhotoProbeResult = {
    scraper_key_present: Boolean(SCRAPER_API_KEY),
    google_key_present: Boolean(GOOGLE_MAPS_API_KEY),
    url_is_redfin: Boolean(verificationUrl && verificationUrl.includes("redfin.com")),
    scraperapi_http_status: null,
    html_length: null,
    regex_match_count: null,
    sample_match: null,
    error: null,
  };
  if (!SCRAPER_API_KEY) {
    result.error = "SCRAPER_API_KEY not configured";
    return result;
  }
  if (!verificationUrl || !verificationUrl.includes("redfin.com")) {
    result.error = "verificationUrl missing or not a redfin.com URL";
    return result;
  }
  const target = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(verificationUrl)}&render=true`;
  try {
    const res = await fetch(target, { cache: "no-store" });
    result.scraperapi_http_status = res.status;
    const html = await res.text();
    result.html_length = html.length;
    const matches = html.match(REDFIN_PHOTO_RE) ?? [];
    const unique = Array.from(new Set(matches));
    result.regex_match_count = unique.length;
    result.sample_match = unique[0] ?? null;
    if (!res.ok) result.error = `ScraperAPI HTTP ${res.status}`;
    return result;
  } catch (err) {
    result.error = String(err).slice(0, 300);
    return result;
  }
}

// ── Firecrawl photo scrape (priority 2) ─────────────────────────────
//
// Hits Firecrawl /v2/scrape with formats: ["html"], then pulls Redfin
// CDN photo URLs from the returned HTML using the same regex the
// ScraperAPI path uses. Firecrawl handles the render + bot-wall already
// (it's how the verify-listing pipeline reads renovation language).
// Returns [] on any error so the caller can fall through.

const FIRECRAWL_HTML_IMG_RE = /https:\/\/[^"'\s)]*?(?:ssl\.cdn-redfin|redfin|zillow|homescom)[^"'\s)]*?\.jpg/gi;

export async function scrapeListingPhotosFirecrawl(
  verificationUrl: string,
  maxPhotos = 6,
): Promise<string[]> {
  if (!FIRECRAWL_API_KEY || !verificationUrl) return [];
  try {
    const res = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: verificationUrl,
        formats: ["html", "markdown"],
      }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      data?: { html?: string; markdown?: string };
    };
    const haystack = `${body.data?.html ?? ""}\n${body.data?.markdown ?? ""}`;
    const matches = haystack.match(FIRECRAWL_HTML_IMG_RE) ?? [];
    return Array.from(new Set(matches)).slice(0, maxPhotos);
  } catch {
    return [];
  }
}

export interface FirecrawlPhotoProbeResult {
  firecrawl_key_present: boolean;
  scrape_status: number | null;
  html_length: number | null;
  markdown_length: number | null;
  img_match_count: number | null;
  sample_match: string | null;
  error: string | null;
}

export async function probeFirecrawlPhotos(
  verificationUrl: string | null,
): Promise<FirecrawlPhotoProbeResult> {
  const result: FirecrawlPhotoProbeResult = {
    firecrawl_key_present: Boolean(FIRECRAWL_API_KEY),
    scrape_status: null,
    html_length: null,
    markdown_length: null,
    img_match_count: null,
    sample_match: null,
    error: null,
  };
  if (!FIRECRAWL_API_KEY) {
    result.error = "FIRECRAWL_API_KEY not configured";
    return result;
  }
  if (!verificationUrl) {
    result.error = "verificationUrl missing";
    return result;
  }
  try {
    const res = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: verificationUrl,
        formats: ["html", "markdown"],
      }),
      cache: "no-store",
    });
    result.scrape_status = res.status;
    const body = (await res.json().catch(() => ({}))) as {
      data?: { html?: string; markdown?: string };
    };
    const html = body.data?.html ?? "";
    const markdown = body.data?.markdown ?? "";
    result.html_length = html.length;
    result.markdown_length = markdown.length;
    const matches = `${html}\n${markdown}`.match(FIRECRAWL_HTML_IMG_RE) ?? [];
    const unique = Array.from(new Set(matches));
    result.img_match_count = unique.length;
    result.sample_match = unique[0] ?? null;
    if (!res.ok) result.error = `Firecrawl HTTP ${res.status}`;
    return result;
  } catch (err) {
    result.error = String(err).slice(0, 300);
    return result;
  }
}

// ── RentCast photo probe (priority 1) ───────────────────────────────
//
// RentCast property/listing payloads MAY include photo URLs under a
// `photos` / `media` array. We already authenticate + pay; if photos
// are present, this is the cleanest path — no scraping, no bot wall,
// no robots.txt. The probe reports exactly what RentCast returned so
// the operator can confirm whether the photos field is populated for
// 924 Sunnyside specifically before we wire it into collectPhotos.

export interface RentCastPhotoProbeResult {
  rentcast_key_present: boolean;
  listings_sale_status: number | null;
  listings_sale_photo_count: number | null;
  properties_status: number | null;
  properties_photo_count: number | null;
  sample_photo: string | null;
  photo_field_keys: string[];
  source: "listings_sale" | "properties" | null;
  error: string | null;
}

export async function probeRentCastPhotos(input: {
  address: string;
  city: string;
  state: string;
  zip: string;
}): Promise<RentCastPhotoProbeResult> {
  const probe = await getListingPhotosFromRentCast(input, { debug: true });
  return {
    rentcast_key_present: probe.keyPresent,
    listings_sale_status: probe.listingsSaleStatus,
    listings_sale_photo_count: probe.listingsSalePhotoCount,
    properties_status: probe.propertiesStatus,
    properties_photo_count: probe.propertiesPhotoCount,
    sample_photo: probe.photos[0] ?? null,
    photo_field_keys: probe.photoFieldKeys,
    source: probe.source,
    error: probe.error,
  };
}

/**
 * Returns combined photo array. Priority order:
 *   1. RentCast structured photos (paid, no scraping)
 *   2. Firecrawl scrape of listing URL (paid, already wired)
 *   3. ScraperAPI raw Redfin scrape (legacy fallback)
 *   4. Google Street View Static (exterior fallback)
 * Capped at maxTotal. Stops once enough photos are collected.
 */
export async function collectPhotos(opts: {
  verificationUrl: string | null;
  fullAddress: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  maxTotal?: number;
}): Promise<CollectedPhoto[]> {
  const out: CollectedPhoto[] = [];
  const max = opts.maxTotal ?? 8;

  // 1. RentCast structured photos.
  if (opts.address && opts.city && opts.state && opts.zip) {
    try {
      const rc = await getListingPhotosFromRentCast({
        address: opts.address,
        city: opts.city,
        state: opts.state,
        zip: opts.zip,
      });
      for (const url of rc.photos) {
        out.push({ url, source: "rentcast" });
        if (out.length >= max) return out;
      }
    } catch {
      // fall through
    }
  }

  // 2. Firecrawl scrape.
  if (out.length === 0 && opts.verificationUrl) {
    const fc = await scrapeListingPhotosFirecrawl(opts.verificationUrl, Math.min(max - 1, 6));
    for (const url of fc) {
      out.push({ url, source: "firecrawl" });
      if (out.length >= max) return out;
    }
  }

  // 3. ScraperAPI raw scrape (legacy).
  if (out.length === 0 && opts.verificationUrl) {
    const listingPhotos = await scrapeListingPhotos(opts.verificationUrl, Math.min(max - 1, 6));
    for (const url of listingPhotos) {
      out.push({ url, source: "listing" });
      if (out.length >= max) return out;
    }
  }

  // 4. Street View fallback (exterior-only).
  const sv = streetViewUrl(opts.fullAddress);
  if (sv) out.push({ url: sv, source: "streetview" });

  return out.slice(0, max);
}
