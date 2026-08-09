// Distress score — the genuine-motivation signal (operator A1, 2026-06-21).
// @agent: scout / appraiser
//
// THE LIVE ROUTER IS THE AIRTABLE `Distress_Score` FORMULA (fldwSjhdhEKVzpVRQ).
// This is the in-code REPLICA the projection / backfill dry-runs read, and the
// reference implementation for the formula edit. Changing this file does NOT
// re-route the live cohort — that needs the one-line Airtable formula edit
// (drop the spread addend); this only stops the replica from encoding the
// contaminated behavior, same posture as the MLS-date projection fix (#34).
//
// A1 — drop the (List − MAO) spread term. Because the opener MAO is the
// 0.65×List autoseed, that addend was max(0, List − 0.65·List)/10000 =
// 0.35·List/10000 = List/28,571 — a PURE LIST-PRICE function that flagged fresh
// market-rate listings "High/Extreme distress" (census 2026-06-21: 15 of 17
// Auto-Proceed leads cleared distress ONLY via this term). Genuine distress is
// aging + price drops:
//
//   spread term ON  (current live): DOM/30 + drops*2 + max(0, List−MAO)/10000
//   spread term OFF (A1):           DOM/30 + drops*2
//
// Faithful to the live formula's guard: BLANK unless DOM is truthy (a property
// listed today has DOM 0 → no score → not distressed) and drops ≥ 0.
//
// PURE. No I/O.

export type DistressBucket = "Low" | "Moderate" | "High" | "Extreme";

export interface DistressInput {
  /** DOM_Calc_V2 (days on market). Null/0 → BLANK score (live AND(DOM,…) guard). */
  dom: number | null;
  /** Price_Drop_Count. */
  priceDrops: number | null;
  listPrice: number | null;
  /** The opener MAO (the autoseed 0.65×List today). Only used by the spread term. */
  mao: number | null;
  /** A1 (operator 2026-06-21): drop the (List − MAO) spread term. Default false
   *  keeps the current live behavior; the env flag DISTRESS_DROP_SPREAD_TERM
   *  drives it from the route. */
  dropSpreadTerm?: boolean;
}

export interface DistressResult {
  /** ROUND(…, 2), or null when the guard fails (matches the BLANK formula). */
  score: number | null;
  bucket: DistressBucket | null;
  /** The distress gate: Moderate+ (score ≥ 3). */
  pass: boolean;
}

const num = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Pure: the live Distress_Score replica, with A1's optional spread-term drop. */
export function computeDistressScore(i: DistressInput): DistressResult {
  const drops = num(i.priceDrops) ? i.priceDrops : 0;
  // Live guard: IF(AND({DOM}, {drops} >= 0), …, BLANK()). DOM truthy ⇒ non-null
  // AND non-zero (a today-listed property has DOM 0 → BLANK).
  if (!num(i.dom) || i.dom === 0 || drops < 0) {
    return { score: null, bucket: null, pass: false };
  }
  const spread =
    !i.dropSpreadTerm && num(i.listPrice) && num(i.mao)
      ? Math.max(0, i.listPrice - i.mao) / 10000
      : 0;
  const score = Math.round((i.dom / 30 + drops * 2 + spread) * 100) / 100;
  const bucket: DistressBucket =
    score < 3 ? "Low" : score < 6 ? "Moderate" : score < 9 ? "High" : "Extreme";
  return { score, bucket, pass: bucket !== "Low" };
}
