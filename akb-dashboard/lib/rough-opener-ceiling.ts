// ROUGH OPENER CEILING (keystone 2026-06-13; LIST-ANCHOR REMOVED 2026-06-28,
// operator ruling). @agent: appraiser
//
// THE DOCTRINE (two numbers, held separate):
//   PRECISE CONTRACT MAO — disciplined renovated-sold comps + DD-pinned
//     rehab band. NULL = HOLD. Never fabricates. Drives Contract_Offer_Price.
//     (lib/pricing/mao-flip 70% rule for the flip lane; lib/landlord-hydrate
//      .computeV21LandlordMao for the landlord lane.)
//   ROUGH OPENER CEILING — THIS module. Cheap to compute at cold-first-touch
//     volume, its only job is to give the opener a real, VALUE-anchored cap so
//     we collect DD without ever sending above what the deal could bear.
//
// ── THE LIST-ANCHOR IS GONE (operator 2026-06-28) ────────────────────────
// After the 18681 Blackmoor catastrophe — 0.65 × $130k list = an $84.5k text
// on a house whose actual value was ~$40k — the opener ceiling is ARV-VALUE
// ONLY:
//     ceiling = ARV × market_buybox − rehab − fee
// ARV is the ZIP's renovated $/sqft (ZIP_ARV_Seed) × the SUBJECT's sqft — a
// number that prices THE house (not a ZIP average, and never the seller's
// asking fantasy). When there is no trusted ARV basis the ceiling is NULL and
// the record HOLDS for operator review. We NEVER anchor to a fraction of the
// list price again: a sight-unseen list fraction routinely over-offers 2–3×
// on a distressed or overpriced listing — the exact bug the operator fought
// for months. A HOLD beats a wrong number. (This deliberately retires the
// 2026-06-14 ruling #3 "flat 65%-of-list fallback" and the list_fraction /
// buyer_median branches that preceded it.)
//
// Maverick's Flag-2 still holds: do NOT point the opener at Your_MAO_V21 —
// that re-conflates the two numbers one field over. The opener reads only the
// cheap stored comp-ARV (or the ZIP $/sqft seed × sqft, fed in as
// realArvMedian) plus stored vision rehab. It never waits on sourced rent or
// cap rate.
//
// "Rough" is the DISCIPLINE, not a license to fabricate: we read Real_ARV_
// Median and Est_Rehab_Mid as-is (wide error, conversation-starter only). The
// precise lane demands disciplined comps + DD; this one does not. But "rough"
// never means "anchored to the wrong number" — roughness lives in the ARV/
// rehab error bars, not in substituting the list price for value.

import { DEFAULT_WHOLESALE_FEE } from "@/lib/pre-contract-math";

/** Placeholder rehab band center when ARV is present but no vision rehab
 *  exists yet — a conservative fraction of ARV. Opener-only; the precise
 *  lane never uses it. Env-tunable. */
export const ROUGH_REHAB_PCT_OF_ARV = (() => {
  const raw = Number(process.env.ROUGH_REHAB_PCT_OF_ARV);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.20;
})();

export type RoughCeilingSource =
  | "rough_buybox_arv"             // ARV + vision rehab + market buy-box
  | "rough_buybox_arv_placeholder_rehab" // ARV present, no vision rehab → placeholder
  | "hold_no_value_basis";         // no trusted ARV value basis → HOLD (never list-anchor)

export interface RoughCeilingInput {
  realArvMedian?: number | null;
  estRehabMid?: number | null;
  estRehab?: number | null;
  /** Retained for caller compatibility + telemetry ONLY. The opener ceiling
   *  is NEVER anchored to list price (operator 2026-06-28) — this field is
   *  read for nothing in the ceiling math; a no-ARV record HOLDs. */
  listPrice?: number | null;
  /** Market buy-box ARV%Max (e.g. Detroit 0.6461). Required for the
   *  value-anchored path; absent → HOLD (no autonomous opener). */
  arvPctMax?: number | null;
  wholesaleFee?: number | null;
}

export interface RoughCeilingResult {
  /** The rough opener ceiling — the cap the anchor multiplies. Null whenever
   *  there is no trusted ARV value basis (→ the record HOLDS for review). */
  ceiling: number | null;
  source: RoughCeilingSource;
  detail: string;
  /** Echoes for audit. */
  arvUsed: number | null;
  rehabUsed: number | null;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const validPct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;

/** Pure: the rough opener ceiling. VALUE-anchored only — never list-anchored.
 *  Null (HOLD) when there is no ARV + sourced buy-box. */
export function computeRoughOpenerCeiling(input: RoughCeilingInput): RoughCeilingResult {
  const fee = pos(input.wholesaleFee) ? input.wholesaleFee : DEFAULT_WHOLESALE_FEE;
  const arv = pos(input.realArvMedian) ? input.realArvMedian : null;

  // VALUE-ANCHORED path: ARV present AND a sourced market discount. This is
  // the ONLY path that produces an opener. ARV is the ZIP renovated $/sqft ×
  // subject sqft (or a stored comp-ARV) — it prices THE house.
  if (arv != null && validPct(input.arvPctMax)) {
    const visionRehab = pos(input.estRehabMid) ? input.estRehabMid : (pos(input.estRehab) ? input.estRehab : null);
    const placeholder = visionRehab == null;
    const rehab = visionRehab ?? Math.round(arv * ROUGH_REHAB_PCT_OF_ARV);
    const ceiling = Math.max(0, Math.round(arv * input.arvPctMax - rehab - fee));
    const source: RoughCeilingSource = placeholder ? "rough_buybox_arv_placeholder_rehab" : "rough_buybox_arv";
    return {
      ceiling,
      source,
      detail:
        `rough ceiling $${ceiling.toLocaleString()} = ARV $${arv.toLocaleString()} × ${input.arvPctMax} ` +
        `− rehab $${rehab.toLocaleString()}${placeholder ? ` (placeholder ${ROUGH_REHAB_PCT_OF_ARV}×ARV — no vision yet)` : " (vision)"} ` +
        `− fee $${fee.toLocaleString()}`,
      arvUsed: arv,
      rehabUsed: rehab,
    };
  }

  // No trusted ARV value basis → HOLD. We do NOT fall back to a fraction of
  // the seller's list price (operator 2026-06-28 — the Blackmoor $84.5k bug).
  // The caller (anchoredOpenerGate / priceOpener) reads this null and routes
  // the record to operator review instead of texting a list-anchored number.
  return {
    ceiling: null,
    source: "hold_no_value_basis",
    detail:
      "no trusted ARV value basis (no ZIP $/sqft seed × sqft and no sourced buy-box) — " +
      "rough opener ceiling is NULL; record HOLDS for review (never anchors to list price)",
    arvUsed: null,
    rehabUsed: null,
  };
}
