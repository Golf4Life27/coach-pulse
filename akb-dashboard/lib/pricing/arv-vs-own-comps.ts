// ARV vs THE RECORD'S OWN COMPS — the cross-check that was never wired.
// @agent: appraiser
//
// WHY (2026-08-14, 9360 Cheyenne). The record stored Real_ARV_Median $154,177
// at HIGH confidence on 1,430 sqft — $107.81/sqft. Sitting in the SAME record,
// in ARV_Comp_Details_JSON, were 44 comps whose median is ~$55/sqft and whose
// single highest print is $95.04. The ARV claimed the finished house was worth
// more per foot than every recent sale around it, and the displayed spread of
// $34,840 was fiction: at a realistic ARV the flip MAO is roughly $9,400, so
// $35,000 sat well ABOVE the lane rather than $34,840 below it.
//
// Nothing caught it because `arvCompDetailsJson` is read into the Listing type
// (lib/airtable.ts, lib/types.ts) and then consumed by NOTHING. The pricer sees
// a ZIP-level seed and a stored ARV; the per-record comps — the closest and
// most specific evidence the system owns — were never opened.
//
// This is the same shape as every other pricing failure found this week: the
// evidence needed to catch the error was already on the record, and no code
// compared the number to it. The opener receipt fixed "can this number be
// reproduced". This fixes "is this number consistent with what we know".
//
// DELIBERATELY REPORT-ONLY FOR NOW. This module computes a verdict; it does
// not hold, clamp, or modify anything. Wiring it into the corroboration gate
// is a threshold decision that needs the blast-radius numbers first — a rail
// tightened blind against a pipeline with many inflated ARVs would drop
// outreach volume to zero, which is the opposite of what it is for.

/** One comp as stored in ARV_Comp_Details_JSON. Every field is optional
 *  because the array is written by several different comp sources. */
interface RawComp {
  price?: unknown;
  sqft?: unknown;
  per_sqft?: unknown;
  formatted_address?: unknown;
  sale_date?: unknown;
}

export interface OwnCompsVerdict {
  /** False when the record cannot support the check at all (no comps, no
   *  sqft, no ARV). Never treated as a pass — it is "unknown". */
  checked: boolean;
  compCount: number;
  /** $/sqft implied by the ARV under test. */
  subjectPsf: number | null;
  medianPsf: number | null;
  minPsf: number | null;
  maxPsf: number | null;
  /** subjectPsf ÷ medianPsf. The headline divergence number. */
  ratioToMedian: number | null;
  /** TRUE when the ARV sits outside what this record's own comps support. */
  outsideBand: boolean;
  /** Which rail tripped — for ranking and for the operator-facing report. */
  rail: "above_every_comp" | "far_above_median" | "below_every_comp" | null;
  reason: string | null;
}

/** Minimum comps before the check means anything. Below this a single odd
 *  print swings the median hard, and a false "inflated ARV" is expensive —
 *  it would park a live deal. */
export const MIN_COMPS_FOR_CHECK = 5;

/** An ARV above the HIGHEST comp on its own record claims the finished house
 *  beats every recent sale nearby. Defensible as a rail because it needs no
 *  tuning: it is a statement about the data, not a chosen tolerance. */
const HIGH_RAIL_ABOVE_MAX = 1.0;

/** Second rail, for a comp set with one wild high print that would otherwise
 *  let an inflated ARV slip under the max. A renovated ARV SHOULD sit above a
 *  mixed as-is/renovated median — 1.75× is generous headroom for that and
 *  still catches Cheyenne at 1.96×. */
const HIGH_RAIL_MEDIAN_MULTIPLE = 1.75;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Pure: the $/sqft of every usable comp in a stored comp array. Prefers
 *  price ÷ sqft over the precomputed per_sqft, so a stale or wrong stored
 *  ratio cannot launder a bad comp through the check. */
export function compPsfs(rawJson: string | null | undefined): number[] {
  if (!rawJson || typeof rawJson !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: number[] = [];
  for (const c of parsed as RawComp[]) {
    if (typeof c !== "object" || c === null) continue;
    const price = num(c.price);
    const sqft = num(c.sqft);
    if (price != null && sqft != null) {
      out.push(price / sqft);
      continue;
    }
    const stored = num(c.per_sqft);
    if (stored != null) out.push(stored);
  }
  return out;
}

/** Pure: does this ARV sit inside the band its OWN record's comps support? */
export function checkArvAgainstOwnComps(input: {
  /** The ARV actually used to produce the number under test. */
  arv: number | null | undefined;
  sqft: number | null | undefined;
  /** Raw ARV_Comp_Details_JSON off the record. */
  compsJson: string | null | undefined;
}): OwnCompsVerdict {
  const unchecked = (reason: string): OwnCompsVerdict => ({
    checked: false, compCount: 0, subjectPsf: null, medianPsf: null,
    minPsf: null, maxPsf: null, ratioToMedian: null, outsideBand: false,
    rail: null, reason,
  });

  const arv = num(input.arv);
  const sqft = num(input.sqft);
  if (arv == null) return unchecked("no_arv");
  if (sqft == null) return unchecked("no_sqft");

  const psfs = compPsfs(input.compsJson).sort((a, b) => a - b);
  if (psfs.length < MIN_COMPS_FOR_CHECK) {
    return unchecked(`too_few_comps (${psfs.length} < ${MIN_COMPS_FOR_CHECK})`);
  }

  const subjectPsf = arv / sqft;
  const medianPsf = median(psfs);
  const minPsf = psfs[0];
  const maxPsf = psfs[psfs.length - 1];
  const ratioToMedian = medianPsf > 0 ? subjectPsf / medianPsf : null;

  const base = {
    checked: true as const, compCount: psfs.length, subjectPsf,
    medianPsf, minPsf, maxPsf, ratioToMedian,
  };
  const money = (n: number) => `$${n.toFixed(2)}`;

  if (subjectPsf > maxPsf * HIGH_RAIL_ABOVE_MAX) {
    return {
      ...base, outsideBand: true, rail: "above_every_comp",
      reason:
        `ARV ${money(subjectPsf)}/sqft exceeds EVERY one of this record's ${psfs.length} comps ` +
        `(highest ${money(maxPsf)}, median ${money(medianPsf)}) — the finished house cannot beat ` +
        `every recent sale around it`,
    };
  }
  if (ratioToMedian != null && ratioToMedian >= HIGH_RAIL_MEDIAN_MULTIPLE) {
    return {
      ...base, outsideBand: true, rail: "far_above_median",
      reason:
        `ARV ${money(subjectPsf)}/sqft is ${ratioToMedian.toFixed(2)}× the median of this record's ` +
        `${psfs.length} comps (${money(medianPsf)}) — beyond the headroom a renovated ARV earns over ` +
        `a mixed as-is/renovated set`,
    };
  }
  if (subjectPsf < minPsf) {
    return {
      ...base, outsideBand: true, rail: "below_every_comp",
      reason:
        `ARV ${money(subjectPsf)}/sqft is BELOW every one of this record's ${psfs.length} comps ` +
        `(lowest ${money(minPsf)}) — reads as an as-is value stored in a renovated-ARV field`,
    };
  }

  return { ...base, outsideBand: false, rail: null, reason: null };
}
