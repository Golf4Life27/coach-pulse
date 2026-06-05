// Rehab read-history median — 2026-06-05.
// @agent: appraiser
//
// Vision rehab confidence is stochastic right at the 60 gate boundary
// (5435 Callaghan produced 62/62/62/58/52/0 across fires on the SAME
// photo set). The prior persist-on-every-fire behavior let a single
// degraded read (a JSON parse-failure → conf=0, or a low outlier)
// OVERWRITE earlier good values, flipping the gate spuriously.
//
// Fix: persist the MEDIAN of the last N=5 VALID reads.
//   - "valid" = a real vision read: conf > 0 AND a positive rehab_mid.
//     Parse-failures / conf=0 are EXCLUDED entirely — never averaged in.
//   - Median (not mean): robust to a single outlier without the
//     anti-conservative upward bias that "keep highest / max" would
//     introduce (max of stochastic reads systematically over-states).
//   - Gate on MEDIAN conf ≥ 60; persist the MEDIAN rehab band.
//
// Pure. No I/O. The route owns reading/writing the rolling history
// (stored in Rehab_Line_Items_JSON.read_history).

export interface RehabRead {
  ts: string;
  conf: number;
  rehab_low: number;
  rehab_mid: number;
  rehab_high: number;
}

export const REHAB_HISTORY_WINDOW = 5;

/** Pure: is this a real vision read worth keeping? conf > 0 (a
 *  parse-failure or refused-vision yields 0) AND a positive rehab_mid. */
export function isValidRehabRead(r: Partial<RehabRead> | null | undefined): r is RehabRead {
  if (!r) return false;
  return (
    typeof r.conf === "number" && Number.isFinite(r.conf) && r.conf > 0 &&
    typeof r.rehab_mid === "number" && Number.isFinite(r.rehab_mid) && r.rehab_mid > 0 &&
    typeof r.rehab_low === "number" && Number.isFinite(r.rehab_low) &&
    typeof r.rehab_high === "number" && Number.isFinite(r.rehab_high) &&
    typeof r.ts === "string"
  );
}

/** Pure: median of a numeric array (sorted; avg of two middles when
 *  even). Returns null on empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface RehabMedianResult {
  /** The valid-read history AFTER folding in newRead (capped to the
   *  last REHAB_HISTORY_WINDOW). Persist this back. */
  history: RehabRead[];
  /** How many valid reads the median is computed over (≤ window). */
  validCount: number;
  /** Median confidence across the window. null when no valid reads. */
  medianConf: number | null;
  medianRehabLow: number | null;
  medianRehabMid: number | null;
  medianRehabHigh: number | null;
  /** Median conf ≥ 60 — the gate signal. false when no valid reads. */
  gatePass: boolean;
  /** Whether newRead was kept (valid) or dropped (invalid misfire). */
  newReadAccepted: boolean;
}

/**
 * Pure: fold a fresh vision read into the rolling valid-read history and
 * compute the median band + gate.
 *
 * - An INVALID newRead (conf 0 / parse-failure / non-positive rehab) is
 *   DROPPED — it does not enter the history and does not perturb the
 *   median. This is the core fix: a misfire can no longer overwrite.
 * - History is capped to the most-recent REHAB_HISTORY_WINDOW valid
 *   reads.
 * - Each field is medianed independently across the window, then
 *   rounded.
 */
export function foldRehabRead(
  priorHistory: RehabRead[] | null | undefined,
  newRead: Partial<RehabRead> | null | undefined,
  window: number = REHAB_HISTORY_WINDOW,
): RehabMedianResult {
  // Sanitize prior history to valid reads only (defensive against a
  // malformed persisted blob).
  const prior = (Array.isArray(priorHistory) ? priorHistory : []).filter(isValidRehabRead);

  const accepted = isValidRehabRead(newRead);
  const merged = accepted ? [...prior, newRead] : prior;
  const history = merged.slice(-window);

  if (history.length === 0) {
    return {
      history,
      validCount: 0,
      medianConf: null,
      medianRehabLow: null,
      medianRehabMid: null,
      medianRehabHigh: null,
      gatePass: false,
      newReadAccepted: accepted,
    };
  }

  const medConf = median(history.map((r) => r.conf));
  const medLow = median(history.map((r) => r.rehab_low));
  const medMid = median(history.map((r) => r.rehab_mid));
  const medHigh = median(history.map((r) => r.rehab_high));

  return {
    history,
    validCount: history.length,
    medianConf: medConf == null ? null : Math.round(medConf),
    medianRehabLow: medLow == null ? null : Math.round(medLow),
    medianRehabMid: medMid == null ? null : Math.round(medMid),
    medianRehabHigh: medHigh == null ? null : Math.round(medHigh),
    gatePass: medConf != null && medConf >= 60,
    newReadAccepted: accepted,
  };
}
