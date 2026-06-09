// Offer-readiness checklist — the four data points a deal needs before an
// offer goes out. Pure, no I/O, test-pinned.
//
// Operator pillar (2026-06-08): "The system is nothing without endlessly
// finding distressed properties, good math, and ticking off our offer
// checklist." This is that checklist, in code:
//
//   1. Comps / ARV        — a real resale value
//   2. Rehab estimate     — what it costs to fix
//   3. CMA                — the operator's market read (captured in the Deal File)
//   4. Buyer ceiling      — what cash buyers will actually pay (InvestorBase)
//
// `ready` is true only when all four are present. Advisory today; this is
// the gate a future auto-offer must pass.

import { resolveBuyerCeiling, pricingPathForState } from "@/lib/markets/disclosure";
import { getMarketForListing } from "@/lib/markets/registry";

export interface OfferReadinessInput {
  realArvMedian?: number | null;
  arvConfidence?: "HIGH" | "MED" | "LOW" | null;
  arvCompCount?: number | null;
  estRehab?: number | null;
  estRehabMid?: number | null;
  rehabConfidenceScore?: number | null;
  /** True when a Deal File exists carrying operator-supplied CMA inputs. */
  hasOperatorCma?: boolean | null;
  /** Cash-buyer ceiling — explicit override. When omitted, it's resolved by
   *  STATE: disclosure → InvestorBase median, non-disclosure → ARV × the
   *  sourced buy-box discount (HOLD when no sourced discount). */
  buyerCeiling?: number | null;
  /** Property state — drives the buyer-ceiling source branch (item 2). */
  state?: string | null;
  /** Property ZIP — resolves the market (and its sourced buy-box discount)
   *  for the non-disclosure ARV→purchase transform. */
  zip?: string | null;
  /** InvestorBase Buyer_Median (Property_Intel) — used in disclosure states. */
  investorBaseMedian?: number | null;
  /** Sourced buy-box ARV%Max override. When omitted, resolved from the
   *  registry by {state, zip}; used to discount ARV (resale) → purchase
   *  ceiling in non-disclosure states. */
  arvDiscountPct?: number | null;
}

export interface ReadinessItem {
  key: "arv" | "rehab" | "cma" | "buyer_ceiling";
  label: string;
  ok: boolean;
  detail: string;
}

export interface OfferReadiness {
  items: ReadinessItem[];
  ready: boolean;
  missing: string[];
}

export function computeOfferReadiness(input: OfferReadinessInput): OfferReadiness {
  const arvVal = typeof input.realArvMedian === "number" && input.realArvMedian > 0 ? input.realArvMedian : null;
  const arvOk = arvVal != null;
  const arvDetail = arvOk
    ? `$${arvVal.toLocaleString()}${input.arvConfidence ? ` · ${input.arvConfidence}` : ""}${typeof input.arvCompCount === "number" ? ` · ${input.arvCompCount} comps` : ""}`
    : "no ARV on record";

  const rehabVal = typeof input.estRehabMid === "number" && input.estRehabMid > 0
    ? input.estRehabMid
    : typeof input.estRehab === "number" && input.estRehab > 0
    ? input.estRehab
    : null;
  const rehabOk = rehabVal != null;
  const rehabDetail = rehabOk
    ? `$${rehabVal.toLocaleString()}${typeof input.rehabConfidenceScore === "number" ? ` · conf ${input.rehabConfidenceScore}` : ""}`
    : "no rehab estimate";

  const cmaOk = input.hasOperatorCma === true;
  const cmaDetail = cmaOk ? "on file (Deal File)" : "no CMA captured";

  // Buyer ceiling branches on state (item 2): an explicit buyerCeiling wins;
  // otherwise disclosure states use the InvestorBase median, and non-
  // disclosure states (TX, …) transform the ARV median (RESALE value) into
  // a buyer purchase ceiling via the SOURCED per-market buy-box discount —
  // never raw ARV. When the market has no sourced discount (e.g. San Antonio,
  // buyer_params:null) the ceiling HOLDs rather than fabricate a number.
  const arvDiscountPct =
    input.arvDiscountPct ??
    getMarketForListing({ state: input.state, zip: input.zip })?.buyer_params?.arv_pct_max ??
    null;
  let bcVal: number | null = null;
  let bcSourceLabel = "";
  if (typeof input.buyerCeiling === "number" && input.buyerCeiling > 0) {
    bcVal = input.buyerCeiling;
    bcSourceLabel = "operator";
  } else {
    const resolved = resolveBuyerCeiling(input.state, {
      investorBaseMedian: input.investorBaseMedian,
      arvMedian: arvVal,
      arvDiscountPct,
    });
    bcVal = resolved.ceiling;
    bcSourceLabel = resolved.source === "arv_comps"
      ? `ARV × ${(arvDiscountPct! * 100).toFixed(1)}% buy-box`
      : resolved.source === "investorbase_median" ? "InvestorBase" : "";
  }
  const bcOk = bcVal != null;
  const bcDetail = bcVal != null ? `$${bcVal.toLocaleString()}${bcSourceLabel ? ` · ${bcSourceLabel}` : ""}` : "no buyer ceiling captured";
  const bcLabel = pricingPathForState(input.state) === "arv_comps" ? "Buyer ceiling (ARV buy-box)" : "Buyer ceiling (InvestorBase)";

  const items: ReadinessItem[] = [
    { key: "arv", label: "Comps / ARV", ok: arvOk, detail: arvDetail },
    { key: "rehab", label: "Rehab estimate", ok: rehabOk, detail: rehabDetail },
    { key: "cma", label: "CMA", ok: cmaOk, detail: cmaDetail },
    { key: "buyer_ceiling", label: bcLabel, ok: bcOk, detail: bcDetail },
  ];
  const missing = items.filter((i) => !i.ok).map((i) => i.label);
  return { items, ready: missing.length === 0, missing };
}
