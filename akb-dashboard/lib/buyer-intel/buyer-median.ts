// Buyer_Median per (ZIP, track) from acquisition prices — fail-closed. M5.
// @agent: appraiser/data_federation
//
// Buyer_Median(zip, track) = median of that track's ACQUISITION prices in the
// ZIP (landlord acquisitions for the landlord track; flipper acquisitions for
// the flipper track — NEVER blended; see csv-parse.ts THE TRAP). Resale_Median
// = median of flipper RESALE prices (ARV/resale evidence), kept separate.
//
// MIN-N GATE (Alex's doctrine): fewer than BUYER_MEDIAN_MIN_N (default 20)
// priced acquisitions for a (ZIP, track) → emit NO median: return INSUFFICIENT
// and route the subject to Manual Review. Never widen silently.
//
// FAIL-CLOSED: no data, thin data, or any error → INSUFFICIENT. Never a
// fabricated or interpolated number.

import type { BuyerTrack } from "@/lib/buyer-median-input";
import type { BuyerTransaction } from "./csv-parse";

export const BUYER_MEDIAN_MIN_N = (() => {
  const raw = Number(process.env.BUYER_MEDIAN_MIN_N);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
})();

/** DEFAULT-OFF. Gates writing computed medians + DD-3 consuming the live store
 *  in production. OFF ⇒ watched mode (compute + trace, write nothing). */
export function isBuyerMedianLive(): boolean {
  return process.env.BUYER_MEDIAN_LIVE === "true";
}

export type BuyerMedianStatus = "OK" | "INSUFFICIENT";

export interface BuyerMedianResult {
  zip: string;
  track: BuyerTrack;
  status: BuyerMedianStatus;
  /** The median acquisition price — ONLY when status === "OK". */
  median: number | null;
  /** Count of priced acquisitions backing the median. */
  n: number;
  minN: number;
  reason: string;
}

const pos = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** The acquisition prices for one (zip, track). */
export function acquisitionPrices(txns: BuyerTransaction[], zip: string, track: BuyerTrack): number[] {
  return txns
    .filter((t) => t.propertyZip === zip && t.buyerType === track && pos(t.acquisitionPrice))
    .map((t) => t.acquisitionPrice as number);
}

/** Buyer_Median(zip, track), fail-closed with the min-n gate. */
export function computeBuyerMedian(
  txns: BuyerTransaction[],
  zip: string,
  track: BuyerTrack,
  minN: number = BUYER_MEDIAN_MIN_N,
): BuyerMedianResult {
  try {
    const prices = acquisitionPrices(txns, zip, track);
    const n = prices.length;
    if (n < minN) {
      return {
        zip, track, status: "INSUFFICIENT", median: null, n, minN,
        reason: `buyer-median insufficient for ZIP ${zip}/${track} (n=${n} < ${minN}), manual review`,
      };
    }
    return {
      zip, track, status: "OK", median: median(prices), n, minN,
      reason: `median of ${n} ${track} acquisitions in ${zip}`,
    };
  } catch (err) {
    // FAIL-CLOSED: any error → INSUFFICIENT, never a fabricated number.
    return { zip, track, status: "INSUFFICIENT", median: null, n: 0, minN, reason: `error → insufficient: ${String(err)}` };
  }
}

/** Resale_Median(zip) from flipper resale prices (ARV/resale evidence). Same
 *  min-n gate; INSUFFICIENT on thin/error. */
export function computeResaleMedian(txns: BuyerTransaction[], zip: string, minN: number = BUYER_MEDIAN_MIN_N): BuyerMedianResult {
  try {
    const prices = txns
      .filter((t) => t.propertyZip === zip && t.buyerType === "flipper" && pos(t.resalePrice))
      .map((t) => t.resalePrice as number);
    const n = prices.length;
    if (n < minN) {
      return { zip, track: "flipper", status: "INSUFFICIENT", median: null, n, minN, reason: `resale-median insufficient for ${zip} (n=${n} < ${minN})` };
    }
    return { zip, track: "flipper", status: "OK", median: median(prices), n, minN, reason: `resale median of ${n} flipper resales in ${zip}` };
  } catch (err) {
    return { zip, track: "flipper", status: "INSUFFICIENT", median: null, n: 0, minN, reason: `error → insufficient: ${String(err)}` };
  }
}

/** THE TRAP value — the naive median of `Most Recent Sale Price` across ALL
 *  rows (landlord acquisition ∪ flipper resale), regardless of track. This is
 *  the blended ~$100k number the engine must NEVER feed to DD-3. Exposed only
 *  so tests can assert the engine never returns it. */
export function naiveMostRecentMedianAllRows(txns: BuyerTransaction[]): number | null {
  const mostRecent = txns
    .map((t) => (t.buyerType === "landlord" ? t.acquisitionPrice : t.buyerType === "flipper" ? t.resalePrice : null))
    .filter((v): v is number => pos(v));
  return median(mostRecent);
}

export interface ZipMedianRow {
  zip: string;
  landlord: BuyerMedianResult;
  flipper: BuyerMedianResult;
  resale: BuyerMedianResult;
}

/** Per-ZIP median table for the watched-run report (pure; no writes). */
export function perZipMedianTable(txns: BuyerTransaction[], minN: number = BUYER_MEDIAN_MIN_N): ZipMedianRow[] {
  const zips = [...new Set(txns.map((t) => t.propertyZip).filter((z) => z !== ""))].sort();
  return zips.map((zip) => ({
    zip,
    landlord: computeBuyerMedian(txns, zip, "landlord", minN),
    flipper: computeBuyerMedian(txns, zip, "flipper", minN),
    resale: computeResaleMedian(txns, zip, minN),
  }));
}
