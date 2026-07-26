// Per-ZIP SATURATION signal (chew-and-move-on, operator /goal 2026-07-26).
//
// THE PROBLEM: ZIP_Registry cadence (lib/crawler/zip-rotation.ts) cools a
// ZIP on *crawl* yield (records ingested / accept rate) but is blind to
// *outreach* yield. A ZIP can crawl clean (fresh listings keep appearing)
// while the SELLERS are saturated — blanketed by competing wholesalers —
// so every text just burns credits and reputation with zero conversion.
// Live example (2026-07-26): an agent in ZIP 44310 replied "We have had
// over 15 of these offers. Seller asked me to stop sending them to him."
// That is a hard, unambiguous signal the market is done, not that this
// one listing is done.
//
// THE FIX: count recent HARD NEGATIVE signals (do-not-text flags, honored
// opt-outs, L3 inbound rejections) per ZIP across the loaded listings. A
// ZIP with enough of these in a short window is "saturated" — feed that
// into recrawlCycleHours (zip-rotation.ts) as a COOLING input, exactly
// like the zero-yield streak. Saturation is NEVER a permanent exclusion:
// the whole point of chew-and-move-on is the system comes back later,
// cheaply, once the market has had time to breathe.
//
// Pure. No I/O — callers (the cron routes) pass in listings already
// loaded for their own purposes.

/** Recency window: how far back a negative signal still counts. */
const ZIP_SATURATION_WINDOW_DAYS_RAW = Number(process.env.ZIP_SATURATION_WINDOW_DAYS);
export const ZIP_SATURATION_WINDOW_DAYS_DEFAULT =
  Number.isFinite(ZIP_SATURATION_WINDOW_DAYS_RAW) && ZIP_SATURATION_WINDOW_DAYS_RAW > 0
    ? Math.floor(ZIP_SATURATION_WINDOW_DAYS_RAW)
    : 14;

/** Negative-signal count at/above which a ZIP is considered saturated. */
const ZIP_SATURATION_THRESHOLD_RAW = Number(process.env.ZIP_SATURATION_THRESHOLD);
export const ZIP_SATURATION_THRESHOLD_DEFAULT =
  Number.isFinite(ZIP_SATURATION_THRESHOLD_RAW) && ZIP_SATURATION_THRESHOLD_RAW > 0
    ? Math.floor(ZIP_SATURATION_THRESHOLD_RAW)
    : 2;

export interface SaturationListing {
  zip: string | null;
  doNotText: boolean | null;
  notes: string | null;
  lastInboundAt: string | null;
}

export interface ZipSaturationOpts {
  /** How far back (days) a negative signal still counts. Default: env
   *  ZIP_SATURATION_WINDOW_DAYS or 14. */
  windowDays?: number;
  /** Negative-signal count at/above which a ZIP is saturated. Default:
   *  env ZIP_SATURATION_THRESHOLD or 2. */
  threshold?: number;
}

export interface ZipSaturationResult {
  negativeSignals: number;
  saturated: boolean;
}

const OPT_OUT_MARKER = "OPT-OUT honored";
const REJECTION_MARKER = "L3 INBOUND: REJECTION";

/** True when this listing's notes/flags amount to a recent hard negative:
 *  doNotText, an honored opt-out, or an L3 inbound rejection — AND the
 *  listing has a lastInboundAt inside the window (recency-gated; a
 *  do-not-text flag from a year ago doesn't indict the ZIP today). */
function isRecentHardNegative(listing: SaturationListing, cutoffMs: number): boolean {
  if (!listing.lastInboundAt) return false;
  const inboundMs = Date.parse(listing.lastInboundAt);
  if (!Number.isFinite(inboundMs) || inboundMs < cutoffMs) return false;

  if (listing.doNotText === true) return true;
  const notes = listing.notes ?? "";
  if (notes.includes(OPT_OUT_MARKER)) return true;
  if (notes.includes(REJECTION_MARKER)) return true;
  return false;
}

/** Pure: per-ZIP saturation from a set of listings.
 *
 *  A listing counts as a negative signal when its ZIP is set AND it shows
 *  a recent hard negative (see isRecentHardNegative) within `windowDays`.
 *  A ZIP is `saturated` once its negative-signal count reaches `threshold`.
 *
 *  Both knobs are env-tunable (ZIP_SATURATION_WINDOW_DAYS,
 *  ZIP_SATURATION_THRESHOLD) with per-call override via `opts`. */
export function computeZipSaturation(
  listings: SaturationListing[],
  now: Date,
  opts?: ZipSaturationOpts,
): Map<string, ZipSaturationResult> {
  const windowDays =
    opts?.windowDays != null && opts.windowDays > 0
      ? Math.floor(opts.windowDays)
      : ZIP_SATURATION_WINDOW_DAYS_DEFAULT;
  const threshold =
    opts?.threshold != null && opts.threshold > 0
      ? Math.floor(opts.threshold)
      : ZIP_SATURATION_THRESHOLD_DEFAULT;

  const cutoffMs = now.getTime() - windowDays * 86_400_000;

  const counts = new Map<string, number>();
  for (const listing of listings) {
    const zip = listing.zip;
    if (!zip) continue;
    if (!isRecentHardNegative(listing, cutoffMs)) continue;
    counts.set(zip, (counts.get(zip) ?? 0) + 1);
  }

  const result = new Map<string, ZipSaturationResult>();
  for (const [zip, negativeSignals] of counts) {
    result.set(zip, { negativeSignals, saturated: negativeSignals >= threshold });
  }
  return result;
}
