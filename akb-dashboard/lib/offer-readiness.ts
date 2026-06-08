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

export interface OfferReadinessInput {
  realArvMedian?: number | null;
  arvConfidence?: "HIGH" | "MED" | "LOW" | null;
  arvCompCount?: number | null;
  estRehab?: number | null;
  estRehabMid?: number | null;
  rehabConfidenceScore?: number | null;
  /** True when a Deal File exists carrying operator-supplied CMA inputs. */
  hasOperatorCma?: boolean | null;
  /** Cash-buyer ceiling (InvestorBase). No persisted source yet → usually null. */
  buyerCeiling?: number | null;
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

  const bcVal = typeof input.buyerCeiling === "number" && input.buyerCeiling > 0 ? input.buyerCeiling : null;
  const bcOk = bcVal != null;
  const bcDetail = bcOk ? `$${bcVal.toLocaleString()}` : "no buyer ceiling captured";

  const items: ReadinessItem[] = [
    { key: "arv", label: "Comps / ARV", ok: arvOk, detail: arvDetail },
    { key: "rehab", label: "Rehab estimate", ok: rehabOk, detail: rehabDetail },
    { key: "cma", label: "CMA", ok: cmaOk, detail: cmaDetail },
    { key: "buyer_ceiling", label: "Buyer ceiling (InvestorBase)", ok: bcOk, detail: bcDetail },
  ];
  const missing = items.filter((i) => !i.ok).map((i) => i.label);
  return { items, ready: missing.length === 0, missing };
}
