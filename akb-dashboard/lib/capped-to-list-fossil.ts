// The capped_to_list fossil detector. @agent: ledger
//
// AUDIT 2026-08-06. Of 819 records carrying BOTH Outreach_Offer_Price and
// List_Price, 808 have an opener EXACTLY 0.65 x list and NO Opener_Basis —
// the retired capped_to_list producer (demoted to a tripwire by operator
// ruling recmy2Vwp1wMA1Vs8, 2026-07-06) fossilised in the field. Created
// 2026-03 (75), 2026-04 (580), 2026-05 (152), 2026-07 (1).
//
// They are not inert. Recomputing 40 against their own stored ARV: 23 offer
// MORE than the ARV-derived MAO supports. 11383 Ohio stores a $14,625 opener
// against a computed MAO of MINUS $85; 7839 Sparta offers $149,175 against a
// $155,465 renovated ARV. And the field is read live — chooseDisplayPrice
// treats it as a price source, negotiation.ts as the legacy opener slot, and
// reply-alert builds "hold at $X" from it when an agent counters.
//
// Pure so the predicate is testable without touching Airtable; the route
// (app/api/cron/purge-capped-to-list) does the I/O.

/** The retired producer's signature. */
export const CAPPED_RATIO = 0.65;

/** Tight on purpose: this predicate DELETES operator data. */
export const CAPPED_TOLERANCE = 0.005;

/** Pure: is this stored opener the capped_to_list fossil?
 *
 *  BOTH conditions are required. The ratio alone would eventually catch a
 *  genuine opener by coincidence; the ABSENT Opener_Basis is the corroborating
 *  fact — every modern priced record names its basis (e.g. "arv_buybox_seed"),
 *  and not one of the 808 does. */
export function isCappedToListFossil(input: {
  listPrice: unknown;
  offer: unknown;
  openerBasis: unknown;
}): boolean {
  const { listPrice: l, offer: o, openerBasis: b } = input;
  if (typeof l !== "number" || typeof o !== "number") return false;
  if (!Number.isFinite(l) || !Number.isFinite(o) || l <= 0 || o <= 0) return false;
  // Names its derivation → produced by the value-anchored path → leave it.
  if (typeof b === "string" && b.trim() !== "") return false;
  return Math.abs(o / l - CAPPED_RATIO) < CAPPED_TOLERANCE;
}
