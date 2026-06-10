// Track-aware ZIP-store-driven underwriter (operator 2026-06-09).
// @agent: appraiser
//
// THE SHIPPED dry-run rejected every 48227 lead as "priceable_market_mao_unknown":
// resolveOpenerCeiling's evaluateDeal path is FLIPPER-only (ARV × arv_pct_max
// − rehab − fee) and needs ARV+rehab. The seeded ZIP-store median is a real
// MAO source on its own — the LANDLORD track on the as-is median is just
// (median − wholesale fee), no rehab subtraction.
//
// This module is the single source of truth: pick the listing's cohort-
// default track, read the ZIP store, and compute track-aware MAO via the
// shipped lib/buyer-median-input.computeTrackAwareMao. The opener guard and
// the underwrite station both call it — no parallel build.
//
// Pure helpers are split out; the I/O wrapper batches ZIP-store reads.

import type { Listing } from "@/lib/types";
import { defaultBuyerTrack, computeTrackAwareMao, type BuyerTrack } from "@/lib/buyer-median-input";
import { getZipBuyerMedian, type ZipBuyerMedian } from "@/lib/buyer-median-store";

export interface UnderwriteContext {
  /** Pre-loaded ZIP+track medians, keyed by `${zip}:${track}`. The admin
   *  station and the batch fill this once per run to avoid N+1 reads. */
  zipMedians: Map<string, ZipBuyerMedian>;
  /** Per-key store-read errors. Populated when a ZIP lookup fails (e.g. the
   *  prod PAT is scoped before Buyer_Median_ZIP existed). The loader does
   *  NOT silently swallow these — the underwrite station + send paths must
   *  surface them so a scope-mismatch can't masquerade as 'no median seeded'. */
  errors: Map<string, string>;
}

export interface ListingMaoFacts {
  /** state: condition / red-flag text used to pick the cohort default. */
  state: string | null;
  zip: string | null;
  redFlags?: string[] | string | null;
  distressBucket?: string | null;
  distressScore?: number | null;
}

export interface TrackAwareUnderwrite {
  track: BuyerTrack;
  /** "investorbase_manual" | "investorbase_auto" — null when no median. */
  buyerMedianSource: string | null;
  buyerMedian: number | null;
  /** Investor_MAO (the cash buyer's max). null on HOLD. */
  investorMao: number | null;
  /** Your_MAO (Investor_MAO − wholesale fee). null on HOLD. */
  yourMao: number | null;
  wholesaleFeeUsed: number;
  formula: string;
  holdReason: string | null;
}

/** Pure: pick the listing's default track from its as-is cohort. */
export function resolveCohortTrack(l: ListingMaoFacts): BuyerTrack {
  const redFlagsText = Array.isArray(l.redFlags) ? l.redFlags.join(" ") : (l.redFlags ?? "");
  return defaultBuyerTrack({
    condition: `${redFlagsText} ${l.distressBucket ?? ""}`,
    distressed: (l.distressScore ?? 0) > 0,
  });
}

/** Pure: compute track-aware MAO from a pre-resolved ZIP median + listing.
 *  Returns HOLD with a precise reason when the median is missing — never a
 *  fabricated number. */
export function computeListingMao(
  l: ListingMaoFacts & { estRehab?: number | null },
  ctx: UnderwriteContext,
): TrackAwareUnderwrite {
  const track = resolveCohortTrack(l);
  const zip = (l.zip ?? "").trim();
  if (!/^\d{5}$/.test(zip)) {
    return {
      track,
      buyerMedianSource: null,
      buyerMedian: null,
      investorMao: null,
      yourMao: null,
      wholesaleFeeUsed: 0,
      formula: "HOLD",
      holdReason: "invalid_zip",
    };
  }
  const median = ctx.zipMedians.get(`${zip}:${track}`) ?? null;
  if (!median) {
    return {
      track,
      buyerMedianSource: null,
      buyerMedian: null,
      investorMao: null,
      yourMao: null,
      wholesaleFeeUsed: 0,
      formula: "HOLD",
      holdReason: `no_zip_store_median_${zip}_${track}`,
    };
  }
  const mao = computeTrackAwareMao({
    track,
    buyerMedian: median.value,
    estRehab: l.estRehab ?? null,
  });
  return {
    track,
    buyerMedianSource: median.source,
    buyerMedian: median.value,
    investorMao: mao.investorMao,
    yourMao: mao.yourMao,
    wholesaleFeeUsed: mao.wholesaleFeeUsed,
    formula: mao.formula,
    holdReason: mao.yourMao == null ? "track_aware_compute_hold" : null,
  };
}

/** Pre-load ZIP+track medians for a set of listings (batched I/O). Errors
 *  per key are captured on the context, never silently swallowed. */
export async function loadUnderwriteContextForListings(listings: Listing[]): Promise<UnderwriteContext> {
  const zipMedians = new Map<string, ZipBuyerMedian>();
  const errors = new Map<string, string>();
  const wanted = new Set<string>();
  for (const l of listings) {
    const zip = (l.zip ?? "").trim();
    if (!/^\d{5}$/.test(zip)) continue;
    const track = resolveCohortTrack(l);
    wanted.add(`${zip}:${track}`);
  }
  for (const key of wanted) {
    const [zip, trackRaw] = key.split(":");
    try {
      const m = await getZipBuyerMedian(zip, trackRaw as BuyerTrack);
      if (m) zipMedians.set(key, m);
    } catch (e) {
      errors.set(key, e instanceof Error ? e.message : String(e));
    }
  }
  return { zipMedians, errors };
}
