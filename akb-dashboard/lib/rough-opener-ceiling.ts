// ROUGH OPENER CEILING (keystone 2026-06-13, spine recmgjlZSwhECn1W0,
// Maverick Flag-2 ruling). @agent: appraiser
//
// THE DOCTRINE (two numbers, held separate):
//   PRECISE CONTRACT MAO — disciplined renovated-sold comps + DD-pinned
//     rehab band. NULL = HOLD. Never fabricates. Drives Contract_Offer_Price.
//     (lib/landlord-hydrate.computeV21LandlordMao for landlord; flipper
//      comp-ARV math is future.)
//   ROUGH OPENER CEILING — THIS module. Cheap to compute at cold-first-
//     touch volume, rarely HOLDs, its only job is to give the opener a
//     real economic cap so we collect DD without ever sending above what
//     the deal could bear. Drives the autonomous opener.
//
// Maverick's Flag-2: do NOT point the opener at Your_MAO_V21 — that re-
// conflates the two numbers one field over. The opener never waits on
// sourced rent or cap rate. It reads only what's already cheaply on the
// record (stored comp-ARV + stored vision rehab) or a conservative
// list fraction when even ARV is absent.
//
// "Rough" is the DISCIPLINE, not the field: we read Real_ARV_Median and
// Est_Rehab_Mid as-is (wide error, conversation-starter only). The precise
// lane demands disciplined comps + DD; this one does not. A market $/sqft
// or list-fraction fallback is honest roughness here because the only
// consequence is gating a first text, never a committed price — distinct
// from the 4/26 fabrication rule, which governs the PRECISE lane.

import { DEFAULT_WHOLESALE_FEE } from "@/lib/pre-contract-math";

/** Placeholder rehab band center when ARV is present but no vision rehab
 *  exists yet — a conservative fraction of ARV. Opener-only; the precise
 *  lane never uses it. Env-tunable. */
export const ROUGH_REHAB_PCT_OF_ARV = (() => {
  const raw = Number(process.env.ROUGH_REHAB_PCT_OF_ARV);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.20;
})();

/** Sight-unseen conservative ceiling as a fraction of list, used ONLY when
 *  no ARV exists. Chosen so a 0.90 market anchor yields ≈ the legacy
 *  65%-of-list opener (0.90 × 0.72 ≈ 0.65). Tunable per market later. */
export const ROUGH_NOARV_CEILING_PCT = (() => {
  const raw = Number(process.env.ROUGH_NOARV_CEILING_PCT);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.72;
})();

export type RoughCeilingSource =
  | "rough_buybox_arv"             // ARV + vision rehab + market buy-box
  | "rough_buybox_arv_placeholder_rehab" // ARV present, no vision rehab → placeholder
  | "list_fraction_no_arv"         // no ARV → conservative list fraction
  | "hold_no_inputs";              // no ARV and no list → genuinely nothing

export interface RoughCeilingInput {
  realArvMedian?: number | null;
  estRehabMid?: number | null;
  estRehab?: number | null;
  listPrice?: number | null;
  /** Market buy-box ARV%Max (e.g. Detroit 0.6461). Required for the
   *  buy-box path; absent → the list-fraction fallback. */
  arvPctMax?: number | null;
  wholesaleFee?: number | null;
}

export interface RoughCeilingResult {
  /** The rough opener ceiling — the cap the anchor multiplies. Null only
   *  when there is no ARV AND no list price (rare). */
  ceiling: number | null;
  source: RoughCeilingSource;
  detail: string;
  /** Echoes for audit. */
  arvUsed: number | null;
  rehabUsed: number | null;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const validPct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;

/** Pure: the rough opener ceiling. Cheap, rarely null. */
export function computeRoughOpenerCeiling(input: RoughCeilingInput): RoughCeilingResult {
  const fee = pos(input.wholesaleFee) ? input.wholesaleFee : DEFAULT_WHOLESALE_FEE;
  const arv = pos(input.realArvMedian) ? input.realArvMedian : null;

  // Buy-box path: ARV present AND a sourced market discount.
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

  // No ARV → conservative list fraction (the conversation-starter cap).
  if (pos(input.listPrice)) {
    const ceiling = Math.round(input.listPrice * ROUGH_NOARV_CEILING_PCT);
    return {
      ceiling,
      source: "list_fraction_no_arv",
      detail: `rough ceiling $${ceiling.toLocaleString()} = list $${input.listPrice.toLocaleString()} × ${ROUGH_NOARV_CEILING_PCT} (no ARV — sight-unseen conservative cap)`,
      arvUsed: null,
      rehabUsed: null,
    };
  }

  return {
    ceiling: null,
    source: "hold_no_inputs",
    detail: "no ARV and no list price — rough ceiling cannot be computed; opener HOLDs",
    arvUsed: null,
    rehabUsed: null,
  };
}
