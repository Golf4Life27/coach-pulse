// Photo gathering for /api/photo-analysis.
//
// Two sources, combined into a single array (max ~8 photos):
//   1. Listing photos scraped from Redfin via ScraperAPI (when
//      Verification_URL points at Redfin).
//   2. Google Street View Static API for the property address.
//
// Both gracefully degrade to [] when their respective API keys are
// missing — the photo-analysis caller should treat an empty array as
// "no visual evidence" and warn rather than block.

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

export interface CollectedPhoto {
  url: string;
  source: "listing" | "streetview";
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
 * Returns combined photo array — listing photos first, then Street View
 * as a fallback / supplemental view. Capped at maxTotal.
 */
export async function collectPhotos(opts: {
  verificationUrl: string | null;
  fullAddress: string;
  maxTotal?: number;
}): Promise<CollectedPhoto[]> {
  const out: CollectedPhoto[] = [];
  const max = opts.maxTotal ?? 8;

  if (opts.verificationUrl) {
    const listingPhotos = await scrapeListingPhotos(opts.verificationUrl, Math.min(max - 1, 6));
    for (const url of listingPhotos) {
      out.push({ url, source: "listing" });
      if (out.length >= max) return out;
    }
  }

  const sv = streetViewUrl(opts.fullAddress);
  if (sv) out.push({ url: sv, source: "streetview" });

  return out.slice(0, max);
}
