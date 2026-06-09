// State disclosure status → pricing path (operator 2026-06-08, item 2).
//
// Finding: InvestorBase gives clean buyer-medians ONLY in disclosure states
// (where sale prices are public). Memphis 38109 (TN, disclosure) returned a
// clean Buyer_Median ($125k). Texas is NON-disclosure, so San Antonio
// InvestorBase exports were ~92% zero — it CANNOT price TX. The Appraiser
// ARV station (RentCast sale comparables, InvestorBase-independent) DOES
// produce usable numbers in TX (e.g. 1138 Santa Anna 78201 → ARV $265,846,
// 3 comps; 427 Donaldson → $312,619, 6 comps; validated 2026-06-04).
//
// So the buyer-ceiling / underwrite branches on the PROPERTY's state:
//   - disclosure state  → InvestorBase buyer-median (the γ-path)
//   - non-disclosure    → ARV-comps (Appraiser station)
//
// Pure + the single source of truth for the branch.

/** US non-disclosure states — sale prices are NOT public record, so an
 *  InvestorBase buyer-median export is mostly zero/unreliable. The classic
 *  12 + the AL/MS partials treated as non-disclosure for pricing safety. */
export const NON_DISCLOSURE_STATES: ReadonlySet<string> = new Set([
  "TX", "UT", "ID", "KS", "LA", "MS", "MO", "MT", "NM", "ND", "WY", "AK", "AL",
]);

export type PricingPath = "investorbase_median" | "arv_comps";

/** Pure: is sale data public in this state (→ InvestorBase usable)? */
export function isDisclosureState(state: string | null | undefined): boolean {
  const s = (state ?? "").trim().toUpperCase();
  if (!s) return false; // unknown → treat as non-disclosure (safer: use ARV)
  return !NON_DISCLOSURE_STATES.has(s);
}

/** Pure: which buyer-ceiling source to trust for a property in this state. */
export function pricingPathForState(state: string | null | undefined): PricingPath {
  return isDisclosureState(state) ? "investorbase_median" : "arv_comps";
}

export interface BuyerCeilingInputs {
  /** InvestorBase Buyer_Median (Property_Intel) — trusted only in disclosure states. */
  investorBaseMedian?: number | null;
  /** ARV median (Appraiser station, RentCast comps) — the non-disclosure source. */
  arvMedian?: number | null;
}

export interface BuyerCeilingResult {
  ceiling: number | null;
  source: PricingPath | null;
  /** Why null, when null (e.g. the state's required source isn't populated). */
  reason: string | null;
}

/** Pure: resolve the buyer ceiling for a property by its state. Disclosure
 *  states use the InvestorBase median; non-disclosure states use the ARV
 *  median. Never crosses the streams — a TX property is NOT priced off a
 *  (likely-zero) InvestorBase export, and the absence of the state-correct
 *  source returns null (HOLD), never a fabricated number. */
export function resolveBuyerCeiling(
  state: string | null | undefined,
  inputs: BuyerCeilingInputs,
): BuyerCeilingResult {
  const path = pricingPathForState(state);
  const positive = (n: number | null | undefined): n is number => typeof n === "number" && n > 0;
  if (path === "investorbase_median") {
    if (positive(inputs.investorBaseMedian)) return { ceiling: inputs.investorBaseMedian, source: "investorbase_median", reason: null };
    return { ceiling: null, source: null, reason: "disclosure_state_missing_investorbase_median" };
  }
  // non-disclosure → ARV comps
  if (positive(inputs.arvMedian)) return { ceiling: inputs.arvMedian, source: "arv_comps", reason: null };
  return { ceiling: null, source: null, reason: "non_disclosure_state_missing_arv" };
}
