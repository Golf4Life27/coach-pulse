// Verified-queue pricing pass — pure planner (M9, operator 2026-06-18).
// @agent: appraiser
//
// The missing belt segment: existing records sit at Pipeline_Stage=verified
// with no path to `priced` (M7 wired the priced writer into fresh-intake only).
// This prices the existing verified backlog off the BUYER-MEDIAN store — the
// conservative, min-n-gated track-aware underwrite (lib/track-aware-underwrite),
// NOT the ARV-multiplier path — so the number is buyer-median-driven with no
// fabricated multipliers. A record with no qualifying median HOLDs (stays
// verified), never a fabricated price.
//
// PURE. No I/O — the caller pre-loads the median context and executes the
// stage transition through the sole-writer engine. Stops at `priced`; never
// advances Gate 1 / outreach.

import { computeListingMao, type UnderwriteContext } from "@/lib/track-aware-underwrite";
import type { Listing } from "@/lib/types";

export interface VerifiedPriceRow {
  recordId: string;
  address: string | null;
  zip: string | null;
  track: string;
  /** "investorbase_manual" | "investorbase_auto" | null */
  buyerMedianSource: string | null;
  buyerMedian: number | null;
  investorMao: number | null;
  yourMao: number | null;
  formula: string;
  decision: "price" | "hold";
  /** Set when decision === "hold" — the precise reason (no median, invalid zip…). */
  holdReason: string | null;
}

/** Pure: compute the buyer-median underwrite for each verified record and
 *  decide price-vs-hold. `price` requires a positive investor MAO off a
 *  qualifying median; everything else HOLDs with a precise reason. */
export function planVerifiedQueuePricing(
  listings: Listing[],
  ctx: UnderwriteContext,
): VerifiedPriceRow[] {
  return listings.map((l) => {
    const uw = computeListingMao(
      {
        state: l.state ?? null,
        zip: l.zip ?? null,
        redFlags: l.rehabRedFlags ?? null,
        distressBucket: l.distressBucket ?? null,
        distressScore: l.distressScore ?? null,
        estRehab: l.estRehab ?? null,
      },
      ctx,
    );
    const priceable = uw.investorMao != null && uw.investorMao > 0;
    return {
      recordId: l.id,
      address: l.address ?? null,
      zip: l.zip ?? null,
      track: uw.track,
      buyerMedianSource: uw.buyerMedianSource,
      buyerMedian: uw.buyerMedian,
      investorMao: uw.investorMao,
      yourMao: uw.yourMao,
      formula: uw.formula,
      decision: priceable ? "price" : "hold",
      holdReason: priceable ? null : uw.holdReason,
    };
  });
}

/** Pure: the batch summary the dry-run reports so the operator can confirm the
 *  math is buyer-median-driven + conservative before any write. */
export function summarizeVerifiedPricing(rows: VerifiedPriceRow[]): {
  batch: number;
  priceable: number;
  held: number;
  by_hold_reason: Record<string, number>;
  by_median_source: Record<string, number>;
} {
  const by_hold_reason: Record<string, number> = {};
  const by_median_source: Record<string, number> = {};
  let priceable = 0;
  for (const r of rows) {
    if (r.decision === "price") {
      priceable++;
      const src = r.buyerMedianSource ?? "unknown";
      by_median_source[src] = (by_median_source[src] ?? 0) + 1;
    } else {
      const reason = r.holdReason ?? "unknown";
      by_hold_reason[reason] = (by_hold_reason[reason] ?? 0) + 1;
    }
  }
  return { batch: rows.length, priceable, held: rows.length - priceable, by_hold_reason, by_median_source };
}
