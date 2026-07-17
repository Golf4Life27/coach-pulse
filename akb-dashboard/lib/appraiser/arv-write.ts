// Honest ARV persistence — a VALID empty result writes its emptiness.
// @agent: appraiser
//
// THE HAZARD (2026-07-17, #126 remediation): the ARV route only wrote when
// arv_mid was non-null ("don't overwrite existing data with null"). That rule
// predates the sold-comps-only engine, when a null meant "compute failed".
// Post-#126 a null arv_mid from a successful compute means something else
// entirely: NO SOLD COMPS EXIST — there is no honest ARV. Skipping the write
// then (a) leaves a known-fabricated number (1122 West Ave's $244,690)
// standing as authoritative, and (b) never stamps ARV_Validated_At, so the
// */5-min backfill re-burns the RentCast call forever. Refuse-and-surface:
// the emptiness IS the result, and it gets written — nulls for the band,
// comp count 0, the exclusion receipts (so the operator sees WHY in the
// panel), and a stamp so every freshness gate knows the fixed engine ruled.
//
// Compute FAILURES (RentCast error, no listing) still write nothing — the
// route returns early before this helper is reached.

import type { ArvIntelligenceResult } from "@/lib/arv-intelligence";

export const ARV_DETAILS_JSON_CAP = 95_000;

/** Pure: the Airtable field payload for a completed ARV compute — real band
 *  or honest emptiness. Receipts prefer the used comps; when none survived,
 *  the EXCLUDED comps (each carrying its excluded_reason) are persisted so
 *  the deal room shows exactly why there is no number. */
export function arvPersistFields(
  arv: Pick<
    ArvIntelligenceResult,
    | "arv_low"
    | "arv_mid"
    | "arv_high"
    | "avg_per_sqft"
    | "comp_count_used"
    | "comps_used"
    | "comps_excluded"
  >,
  confidence: string,
  nowIso: string,
): Record<string, unknown> {
  const receipts = arv.comps_used.length > 0 ? arv.comps_used : arv.comps_excluded;
  return {
    Real_ARV_Low: arv.arv_low,
    Real_ARV_High: arv.arv_high,
    Real_ARV_Median: arv.arv_mid,
    ARV_Confidence: confidence,
    ARV_Comp_Count: arv.comp_count_used,
    ARV_Comp_Avg_PrSqFt: arv.avg_per_sqft,
    ARV_Comp_Details_JSON: JSON.stringify(receipts).slice(0, ARV_DETAILS_JSON_CAP),
    ARV_Validated_At: nowIso,
  };
}
