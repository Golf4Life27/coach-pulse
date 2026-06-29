// Cash-offer MAO — the 70% rule, anchored to ARV (comp value), NEVER list price.
// @agent: appraiser
//
// Copied from BuyBoxCartel / HMHW's "Fix & Flip Calc" (operator-supplied
// 2026-06-26) — a PROVEN methodology, not a reinvented one. It replaces the
// broken `0.65 × List_Price` opener that anchored every offer to the seller's
// ASKING price (a fantasy) instead of the property's VALUE. That bug texted
// $84k on a house whose comps said $64.5k; this module makes that impossible.
//
//   ARV   = Subject SqFt × AVERAGE(comp $/sqft)          [renovated/sold comps]
//   MAO   = (ARV × rulePct) − Rehab − (ARV × rulePct × closingPct)
//   Offer = MAO − Assignment Fee
//
// rulePct 0.70 = the "70% rule"; closingPct 1.5% on the 70%-of-ARV basis; the
// fee is your wholesale spread, baked into the SELLER offer so the spread is
// structurally guaranteed (you contract at `offer`, assign at up to `mao`).
//
// ── STRUCTURAL GUARD against the old failure ───────────────────────────────
// This module has NO list-price input. There is no field, parameter, or path
// by which the asking price can enter the calculation. The ONLY value anchor it
// accepts is ARV (derived from comps). The `0.65 × list` bug is not "fixed" —
// it is made unrepresentable.
//
// PURE. No I/O, no clock. Verdict shape mirrors assignment-spread.ts.

export const FLIP_RULE_PCT = 0.7; // the "70% rule" (HMHW default)
export const FLIP_CLOSING_PCT = 0.015; // 1.5% closing on the 70%-of-ARV basis
export const DEFAULT_ASSIGNMENT_FEE = 10_000; // HMHW default; operator-tunable per market

/** Condition → rehab $/sqft (HMHW "Rehab Estimator" tiers). The AI photo
 *  estimator overrides these when it has a number; this is the deterministic
 *  fallback so a rehab figure always exists for the math. */
export const REHAB_RATE_PER_SQFT = {
  fully_flipped: 0,
  very_light: 5,
  light: 15,
  medium: 30,
  heavy: 70,
} as const;
export type RehabTier = keyof typeof REHAB_RATE_PER_SQFT;

/** A usable, strictly-positive number. */
function positive(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n) && n > 0;
}
/** A usable number that may be zero (rehab can legitimately be $0 = fully flipped). */
function nonNegative(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n) && n >= 0;
}

/** Pure: ARV = subject sqft × average of the comps' sold $/sqft. Comps are the
 *  sold price-per-sqft of renovated properties within ~1 mile (HMHW uses 3+).
 *  Returns null if sqft or comps are unusable — an ARV we cannot anchor to is
 *  never fabricated, and (critically) is never back-filled from list price. */
export function arvFromComps(
  subjectSqft: number | null | undefined,
  compPricePerSqft: Array<number | null | undefined>,
): number | null {
  if (!positive(subjectSqft)) return null;
  const usable = compPricePerSqft.filter(positive);
  if (usable.length === 0) return null;
  const avgPsf = usable.reduce((a, b) => a + b, 0) / usable.length;
  return Math.round(subjectSqft * avgPsf);
}

/** Pure: deterministic rehab fallback — sqft × the condition tier's $/sqft.
 *  "fully_flipped" returns 0 even with no sqft; every other tier needs sqft. */
export function rehabBySqft(
  sqft: number | null | undefined,
  tier: RehabTier,
): number | null {
  const rate = REHAB_RATE_PER_SQFT[tier];
  if (rate === 0) return 0;
  if (!positive(sqft)) return null;
  return Math.round(sqft * rate);
}

export interface FlipOfferInputs {
  /** After-repair value, from comps (arvFromComps). The ONLY value anchor. */
  arv: number | null | undefined;
  /** Repair budget, from the AI estimator or rehabBySqft. $0 allowed. */
  rehab: number | null | undefined;
  /** Wholesale fee baked into the seller offer. Default DEFAULT_ASSIGNMENT_FEE. */
  assignmentFee?: number | null | undefined;
  /** Override the 70% rule (e.g. 0.75 in a hotter market). Default FLIP_RULE_PCT. */
  rulePct?: number | null | undefined;
  /** Override the 1.5% closing factor. Default FLIP_CLOSING_PCT. */
  closingPct?: number | null | undefined;
}

export type FlipOfferStatus = "offer" | "hold" | "no_deal";

export interface FlipOfferResult {
  /** offer — a sendable seller offer. hold — missing ARV/rehab (retry-able, no
   *  guessing). no_deal — pencils to ≤ $0 as a flip (rehab too deep vs ARV). */
  status: FlipOfferStatus;
  arv: number | null;
  rehab: number | null;
  /** ARV × rulePct — the "70% of ARV" number. */
  basis: number | null;
  /** basis × closingPct. */
  closing: number | null;
  /** (basis) − rehab − closing — the dispo ceiling (what a cash buyer pays). */
  mao: number | null;
  /** mao − fee — what we offer the seller (our target contract price). */
  offer: number | null;
  assignmentFeeUsed: number;
  rulePctUsed: number;
  reason: string;
}

/** Pure: the cash-offer MAO + seller offer from the 70% rule. Never throws.
 *  ARV missing → hold (we pull comps; we do NOT fall back to list price). */
export function computeFlipOffer(inputs: FlipOfferInputs): FlipOfferResult {
  const fee =
    inputs.assignmentFee == null || !Number.isFinite(inputs.assignmentFee) || inputs.assignmentFee < 0
      ? DEFAULT_ASSIGNMENT_FEE
      : inputs.assignmentFee;
  const rulePct = positive(inputs.rulePct) ? inputs.rulePct : FLIP_RULE_PCT;
  const closingPct = nonNegative(inputs.closingPct) ? inputs.closingPct : FLIP_CLOSING_PCT;

  const base = {
    arv: null as number | null,
    rehab: null as number | null,
    basis: null as number | null,
    closing: null as number | null,
    mao: null as number | null,
    offer: null as number | null,
    assignmentFeeUsed: fee,
    rulePctUsed: rulePct,
  };

  // ARV unknown → HOLD. The one thing we never do is anchor to the list price.
  if (!positive(inputs.arv)) {
    return {
      ...base,
      status: "hold",
      reason: "ARV unknown — pull comps and compute ARV first. Offers are NEVER anchored to the list/asking price.",
    };
  }
  // Rehab unknown → HOLD (run the rehab estimator; $0 is a valid answer, null is not).
  if (!nonNegative(inputs.rehab)) {
    return {
      ...base,
      arv: Math.round(inputs.arv),
      status: "hold",
      reason: "Rehab estimate unknown — run the rehab estimator (or rehabBySqft) before pricing.",
    };
  }

  const arv = Math.round(inputs.arv);
  const rehab = Math.round(inputs.rehab);
  const basisRaw = inputs.arv * rulePct;
  const basis = Math.round(basisRaw);
  const closing = Math.round(basisRaw * closingPct);
  // Compute MAO from the raw basis to match HMHW's spreadsheet to the dollar.
  const mao = Math.round(basisRaw - rehab - basisRaw * closingPct);
  const offer = mao - fee;

  // Doesn't pencil as a flip at this ARV/rehab → no_deal (consider the
  // rental/creative model — a separate calc — rather than forcing a number).
  if (offer <= 0) {
    return {
      ...base,
      arv,
      rehab,
      basis,
      closing,
      mao,
      offer,
      status: "no_deal",
      reason: `No flip deal: 70% of ARV $${arv.toLocaleString()} (=$${basis.toLocaleString()}) − rehab $${rehab.toLocaleString()} − closing − fee $${fee.toLocaleString()} ≤ $0. Too thin to wholesale as a flip; evaluate the rental/creative model instead.`,
    };
  }

  return {
    ...base,
    arv,
    rehab,
    basis,
    closing,
    mao,
    offer,
    status: "offer",
    reason: `Offer $${offer.toLocaleString()} (MAO $${mao.toLocaleString()} − fee $${fee.toLocaleString()}). MAO = 70% of ARV $${arv.toLocaleString()} ($${basis.toLocaleString()}) − rehab $${rehab.toLocaleString()} − closing $${closing.toLocaleString()}.`,
  };
}
