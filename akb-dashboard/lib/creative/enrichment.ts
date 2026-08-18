// PropStream enrichment — parse the snapshot blob + lien-aware send ordering.
// @agent: crier
//
// SOURCE (2026-08-18): the operator ran the creative cohort through
// PropStream's Route A (import → append → 148-col export, Marketing List
// "SF Enrichment 2026-08-18"). 3,005 of 3,137 cohort records matched on
// normalized street + zip and carry a compact JSON snapshot in
// PropStream_Enrichment_JSON. It is a SNAPSHOT — `at` says when; a re-export
// refreshes it (free within a PropStream billing period).
//
// WHY ORDERING CHANGES: the terms opener asks the mortgage question because
// lien status decides the structure. The snapshot ANSWERS it for most of the
// cohort before the first text: a free-and-clear absentee owner is the clean
// seller-finance counterparty (no underlying loan to wrap, not their home),
// and a last-cash-buyer bought without financing at least once already.
// Measured on the matched sendable cohort (1,801): 952 free-and-clear,
// 1,279 absentee, 698 both, 628 both + last-cash-buyer.

import type { SellerFinanceOffer } from "@/lib/creative/seller-finance";
import { termsPriority } from "@/lib/creative/terms-opener";

export interface PropStreamEnrichment {
  ownerOccupied: boolean | null;
  openLoans: number | null;
  estEquity: number | null;
  estLtv: number | null;
  /** PropStream's Monthly Rent estimate (their AVM) — a zero-cost second opinion. */
  psRent: number | null;
  lastCashBuyer: boolean | null;
  vacant: boolean | null;
  deceasedOwner: boolean | null;
  /** Snapshot date (YYYY-MM-DD). */
  at: string | null;
}

/** Parse the compact snapshot blob. Null on missing/garbled input — every
 *  consumer must behave sensibly with no enrichment (the unmatched 132). */
export function parsePropStreamEnrichment(raw: string | null | undefined): PropStreamEnrichment | null {
  if (!raw || !raw.trim()) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    ownerOccupied: bool(obj.oo),
    openLoans: num(obj.loans),
    estEquity: num(obj.eq),
    estLtv: num(obj.ltv),
    psRent: num(obj.rent),
    lastCashBuyer: bool(obj.cash),
    vacant: bool(obj.vac),
    deceasedOwner: bool(obj.dec),
    at: typeof obj.at === "string" ? obj.at : null,
  };
}

/** True only when PropStream affirmatively reports zero open loans.
 *  `loans` null/missing (163 of 3,005 matched) is UNKNOWN, not free-and-clear. */
export function isFreeAndClear(e: PropStreamEnrichment | null): boolean {
  return e?.openLoans === 0;
}

/** True only when PropStream affirmatively reports the owner absent. */
export function isAbsentee(e: PropStreamEnrichment | null): boolean {
  return e?.ownerOccupied === false;
}

/** Lien-aware send-ordering score, higher first. Strict tiers above the
 *  base termsPriority (which stays 0..1999: full-ask beats capped, then
 *  buyer CoC): free-and-clear dominates (the structure is clean), then
 *  absentee, then last-cash-buyer. Unknown enrichment adds nothing — an
 *  unmatched record competes on offer quality alone, it is never buried
 *  below known-bad records. */
export function creativePriority(offer: SellerFinanceOffer, e: PropStreamEnrichment | null): number {
  return (
    (isFreeAndClear(e) ? 8_000 : 0) +
    (isAbsentee(e) ? 4_000 : 0) +
    (e?.lastCashBuyer === true ? 2_000 : 0) +
    termsPriority(offer)
  );
}

/** Rent selection with the PropStream second opinion.
 *
 *  CALIBRATION FINDING (2026-08-18, n=2,690 modeled-rent records with a PS
 *  rent): our ZIP model reads +9.5% median above PropStream's estimate, only
 *  55% within ±20%. Neither is ground truth, but seller-finance payments are
 *  carried BY the rent — an optimistic rent overstates buyer cashflow. So:
 *  when both estimates exist, use the LOWER (payments only ever get safer);
 *  when only PS exists (rent-holds our model can't reach: no sqft / thin
 *  ZIP), use PS with the same 0.9 haircut modeled_zip gets. A RentCast AVM
 *  on the record still wins upstream — this function is the fallback chain. */
export function pickRentWithEnrichment(
  modeled: { rent: number; basis: string } | null,
  e: PropStreamEnrichment | null,
): { rent: number; basis: string } | null {
  const ps = e?.psRent != null && e.psRent > 0 ? e.psRent : null;
  if (modeled && ps != null) {
    return ps < modeled.rent ? { rent: ps, basis: "propstream_min" } : modeled;
  }
  if (modeled) return modeled;
  if (ps != null) return { rent: Math.round(ps * 0.9), basis: "propstream_avm" };
  return null;
}
