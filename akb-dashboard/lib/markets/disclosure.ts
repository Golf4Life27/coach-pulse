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

/** US states where an InvestorBase buyer-median export is mostly
 *  zero/unreliable: the classic legal 12 + Alabama (partial-disclosure).
 *
 *  Consolidation Night 2026-07-29: re-exported from the single source of
 *  truth in state-disclosure.ts — this module previously hardcoded its own
 *  13-state copy that silently disagreed with lib/markets/registry.ts (12,
 *  no AL). The name NON_DISCLOSURE_STATES is kept for this module's
 *  existing consumers, but the semantics here have always been "buyer
 *  median unreliable", which is the wider set. See state-disclosure.ts. */
export {
  BUYER_MEDIAN_UNRELIABLE_STATES as NON_DISCLOSURE_STATES,
} from "@/lib/markets/state-disclosure";
import { BUYER_MEDIAN_UNRELIABLE_STATES as NON_DISCLOSURE_STATES } from "@/lib/markets/state-disclosure";

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
  /** InvestorBase Buyer_Median (Property_Intel) — already a real buyer
   *  PURCHASE price in a disclosure state, so used directly. */
  investorBaseMedian?: number | null;
  /** ARV median (Appraiser station, RentCast comps). This is RESALE value,
   *  NOT a purchase price — it must be transformed by a sourced buy-box
   *  discount before it can serve as a buyer ceiling (see arvDiscountPct). */
  arvMedian?: number | null;
  /** Sourced per-market buy-box ARV%Max (e.g. Detroit 0.6461, Dallas 0.5883)
   *  from the BBC registry. REQUIRED to turn a non-disclosure ARV (resale)
   *  into a buyer purchase ceiling: ceiling = ARV × arvDiscountPct. Absent
   *  → HOLD. This is the guard against treating resale value as a purchase
   *  price; San Antonio (buyer_params:null) has no sourced discount → HOLD. */
  arvDiscountPct?: number | null;
}

export interface BuyerCeilingResult {
  ceiling: number | null;
  source: PricingPath | null;
  /** Why null, when null (e.g. the state's required source isn't populated). */
  reason: string | null;
}

/** Pure: resolve the buyer ceiling for a property by its state. Disclosure
 *  states use the InvestorBase median (already a purchase price). Non-
 *  disclosure states transform the ARV median (RESALE value) into a buyer
 *  purchase ceiling via a SOURCED buy-box discount — never the raw ARV.
 *  Never crosses the streams, and the absence of the state-correct source
 *  (or, for non-disclosure, the sourced discount) returns null (HOLD),
 *  never a fabricated number. */
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
  // Non-disclosure → ARV comps, but ARV is RESALE value: it must be
  // discounted by the sourced buy-box %, never used raw. Missing ARV or a
  // missing sourced discount both HOLD (no fabricated number, no resale-as-
  // purchase). arvDiscountPct must be in (0, 1].
  if (!positive(inputs.arvMedian)) {
    return { ceiling: null, source: null, reason: "non_disclosure_state_missing_arv" };
  }
  if (!positive(inputs.arvDiscountPct) || (inputs.arvDiscountPct as number) > 1) {
    return { ceiling: null, source: null, reason: "non_disclosure_state_missing_sourced_buybox_discount" };
  }
  const ceiling = Math.round((inputs.arvMedian as number) * (inputs.arvDiscountPct as number));
  return { ceiling, source: "arv_comps", reason: null };
}
