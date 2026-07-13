// DECISION MATH — the per-record go/no-go set (2026-07-13). @agent: appraiser
//
// Discovered on three live, actively-negotiating deals (Mayfield / 716 8th /
// Bennett): every decision-critical number was missing at the record level —
// no ARV, no rehab, no MAO, no spread — so when a seller countered ($27k on
// Mayfield) there was NO ceiling to check the counter against. This module
// computes the full margin picture from a record's stored underwrite and
// resolves it to one verdict the operator can read in 15 seconds.
//
// GROUND TRUTH (codebase over brief, SYSTEM_FACTS field-id rule):
//   • Flip lane math = lib/pricing/mao-flip.computeFlipOffer:
//       basis   = ARV × 0.70
//       mao     = basis − rehab − basis×1.5%   ← the DISPO CEILING (what a
//                                                 cash buyer pays) = Buyer_Ceiling
//       offer   = mao − fee                    ← Your MAO (flip lane)
//     (The build brief's "Buyer_Ceiling = ARV×0.70 − Rehab" omitted the
//     closing deduction; the codebase formula wins.)
//   • Landlord lane ceiling = Investor_MAO_V21 (computeV21LandlordMao),
//     your number = Your_MAO_V21. Governing lane = the HIGHER ceiling —
//     the exit is whichever buyer class pays more.
//   • Fee floor $5k = lib/pre-contract-math.DEFAULT_WHOLESALE_FEE.
//     Fee target $10k = lib/pricing/mao-flip.DEFAULT_ASSIGNMENT_FEE.
//   • Vision cutline: rehab MEDIAN confidence ≥ 60 prices autonomously
//     (rehab route gate); below → HOLD_LOW_CONF, never a confident verdict
//     on a guessed number.
//   • Recompute tolerance ±$5 (pricing-doctrine standard 1) — inputs are
//     bucketed to $5 before hashing, so a recompute inside tolerance is a
//     hash no-op and never churns the record or Spine.
//
// PURE. No I/O, no clock (caller passes nowIso). Type 1: computes and
// renders only — never sends, never flips counterparty-facing status.

import {
  computeFlipOffer,
  DEFAULT_ASSIGNMENT_FEE,
} from "@/lib/pricing/mao-flip";
import { DEFAULT_WHOLESALE_FEE } from "@/lib/pre-contract-math";
import type { Listing } from "@/lib/types";

/** Spread floor — below this the deal doesn't pay for its own paperwork. */
export const SPREAD_FLOOR_USD = DEFAULT_WHOLESALE_FEE; // $5,000
/** Spread target — the fee the flip math bakes into every seller offer. */
export const SPREAD_TARGET_USD = DEFAULT_ASSIGNMENT_FEE; // $10,000
/** All-in (price + rehab) as % of ARV must stay at/below the 70% line. */
export const ALL_IN_MAX = 0.7;
/** Rehab vision-confidence cutline (median conf ≥ 60 prices autonomously). */
export const VISION_CONF_CUTLINE = 60;
/** ±$ tolerance bucket for the inputs hash (pricing-doctrine standard 1). */
export const RECOMPUTE_TOLERANCE_USD = 5;

export type DecisionVerdict = "GO" | "TIGHT" | "PASS" | "NEEDS_DATA" | "HOLD_LOW_CONF";
export type UnderwriteConfidence = "High" | "Med" | "Low";
export type PriceSource = "contract" | "counter" | "opener" | "none";
export type CeilingLane = "flip" | "landlord" | null;

/** The record fields the decision reads — a Listing subset, kept explicit so
 *  tests and the client-side card can feed it without a full Listing. */
export interface DecisionRecordInputs {
  /** Real_ARV_Median — comp-anchored, never list-derived. */
  arv: number | null | undefined;
  arvConfidence: "HIGH" | "MED" | "LOW" | null | undefined;
  /** Est_Rehab_Mid preferred, legacy Est_Rehab fallback (mao-range pick). */
  rehabMid: number | null | undefined;
  /** Rehab_Confidence_Score 0-100; null = non-vision (manual/deterministic) rehab. */
  rehabConfidenceScore: number | null | undefined;
  /** Operator-confirmed negotiated price (never overwritten by machines). */
  contractOfferPrice: number | null | undefined;
  /** Latest classified seller counter (Latest_Counter_Usd). */
  latestCounterUsd: number | null | undefined;
  /** The value-anchored opener actually sent (Rough_Opener_Amount). */
  roughOpenerAmount: number | null | undefined;
  /** Legacy outreach slot — last-resort price echo. */
  outreachOfferPrice: number | null | undefined;
  listPrice: number | null | undefined;
  /** Wholesale_Fee_Target — fee baked into the flip offer. Default $10k. */
  wholesaleFeeTarget: number | null | undefined;
  /** Landlord lane (V2.1) numbers when underwritten. */
  yourMaoV21: number | null | undefined;
  investorMaoV21: number | null | undefined;
}

export interface DecisionMathResult {
  verdict: DecisionVerdict;
  /** One-line, card-ready reason (what's missing / what broke the deal /
   *  what clears). Never empty. */
  reason: string;
  /** Dispo ceiling — what the governing buyer class pays. */
  buyerCeiling: number | null;
  ceilingLane: CeilingLane;
  /** Your fee at the current price = buyerCeiling − currentPrice. */
  dealSpread: number | null;
  /** (currentPrice + rehab) ÷ ARV. */
  allInPctArv: number | null;
  /** Your MAO on the governing lane (flip: mao−fee; landlord: Your_MAO_V21). */
  yourMao: number | null;
  currentPrice: number | null;
  priceSource: PriceSource;
  confidence: UnderwriteConfidence;
  /** Flip-lane internals for the card's waterfall (null when ARV/rehab missing). */
  waterfall: {
    arv: number | null;
    basis: number | null; // ARV × 0.70
    rehab: number | null;
    closing: number | null;
    buyerCeilingFlip: number | null; // basis − rehab − closing
    fee: number;
    yourMaoFlip: number | null; // ceiling − fee
  };
  /** ±$5-bucketed stable hash of every input — recompute no-op detector. */
  inputsHash: string;
}

function usable(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n) && n > 0;
}

/** Map a Listing's stored fields to decision inputs. Pure — shared by the
 *  server persist path and the client-side Decision Card (both render the
 *  SAME math from the same module; no parallel formula). */
export function decisionInputsFromListing(
  l: Listing,
  overrides: { latestCounterUsd?: number | null } = {},
): DecisionRecordInputs {
  return {
    arv: l.realArvMedian ?? null,
    arvConfidence: l.arvConfidence ?? null,
    rehabMid: l.estRehabMid ?? l.estRehab ?? null,
    rehabConfidenceScore: l.rehabConfidenceScore ?? null,
    contractOfferPrice: l.contractOfferPrice ?? null,
    latestCounterUsd: overrides.latestCounterUsd ?? l.latestCounterUsd ?? null,
    roughOpenerAmount: l.roughOpenerAmount ?? null,
    outreachOfferPrice: l.outreachOfferPrice ?? null,
    listPrice: l.listPrice ?? null,
    wholesaleFeeTarget: l.wholesaleFeeTarget ?? null,
    yourMaoV21: l.yourMao ?? null,
    investorMaoV21: l.investorMao ?? null,
  };
}

/** Current price chain (brief §Part A): operator contract price → live
 *  counter → the opener actually sent → legacy outreach echo. */
export function resolveCurrentPrice(inputs: {
  contractOfferPrice: number | null | undefined;
  latestCounterUsd: number | null | undefined;
  roughOpenerAmount: number | null | undefined;
  outreachOfferPrice: number | null | undefined;
}): { price: number | null; source: PriceSource } {
  if (usable(inputs.contractOfferPrice)) return { price: Math.round(inputs.contractOfferPrice), source: "contract" };
  if (usable(inputs.latestCounterUsd)) return { price: Math.round(inputs.latestCounterUsd), source: "counter" };
  if (usable(inputs.roughOpenerAmount)) return { price: Math.round(inputs.roughOpenerAmount), source: "opener" };
  if (usable(inputs.outreachOfferPrice)) return { price: Math.round(inputs.outreachOfferPrice), source: "opener" };
  return { price: null, source: "none" };
}

/** Confidence rollup — one High/Med/Low flag from ARV comp-count confidence
 *  + rehab vision score. A null rehab score with a rehab number present is a
 *  non-vision estimate (manual tier / deterministic sqft) → Med leg. */
export function rollupConfidence(
  arvConfidence: "HIGH" | "MED" | "LOW" | null | undefined,
  rehabConfidenceScore: number | null | undefined,
): UnderwriteConfidence {
  const arvLeg: UnderwriteConfidence =
    arvConfidence === "HIGH" ? "High" : arvConfidence === "MED" ? "Med" : "Low";
  const rehabLeg: UnderwriteConfidence =
    rehabConfidenceScore == null
      ? "Med"
      : rehabConfidenceScore >= VISION_CONF_CUTLINE
        ? "High"
        : "Low";
  if (arvLeg === "Low" || rehabLeg === "Low") return "Low";
  if (arvLeg === "High" && rehabLeg === "High") return "High";
  return "Med";
}

/** Stable ±$5-bucketed hash of the decision inputs. Two input sets whose
 *  every number is within the tolerance bucket produce the same hash, so a
 *  recompute inside tolerance is a no-op (no record churn, no Spine noise). */
export function decisionInputsHash(inputs: DecisionRecordInputs): string {
  const bucket = (n: number | null | undefined): string =>
    n == null || !Number.isFinite(n) ? "-" : String(Math.round(n / RECOMPUTE_TOLERANCE_USD));
  const parts = [
    bucket(inputs.arv),
    inputs.arvConfidence ?? "-",
    bucket(inputs.rehabMid),
    inputs.rehabConfidenceScore == null ? "-" : String(Math.round(inputs.rehabConfidenceScore)),
    bucket(inputs.contractOfferPrice),
    bucket(inputs.latestCounterUsd),
    bucket(inputs.roughOpenerAmount),
    bucket(inputs.outreachOfferPrice),
    bucket(inputs.wholesaleFeeTarget),
    bucket(inputs.yourMaoV21),
    bucket(inputs.investorMaoV21),
  ].join("|");
  // djb2 — tiny, stable, dependency-free.
  let h = 5381;
  for (let i = 0; i < parts.length; i++) h = ((h << 5) + h + parts.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** THE verdict. Precedence: NEEDS_DATA (can't compute) → HOLD_LOW_CONF
 *  (could compute, shouldn't trust) → PASS / GO / TIGHT (the margin call). */
export function computeDecisionMath(inputs: DecisionRecordInputs): DecisionMathResult {
  const fee = usable(inputs.wholesaleFeeTarget) ? Math.round(inputs.wholesaleFeeTarget) : SPREAD_TARGET_USD;
  const { price: currentPrice, source: priceSource } = resolveCurrentPrice(inputs);
  const confidence = rollupConfidence(inputs.arvConfidence, inputs.rehabConfidenceScore);
  const inputsHash = decisionInputsHash(inputs);

  // Flip lane — the ONLY value anchor is ARV (list price is unrepresentable
  // in computeFlipOffer by design).
  const flip = computeFlipOffer({
    arv: inputs.arv ?? null,
    rehab: inputs.rehabMid ?? null,
    assignmentFee: fee,
  });
  const waterfall: DecisionMathResult["waterfall"] = {
    arv: flip.arv,
    basis: flip.basis,
    rehab: flip.rehab,
    closing: flip.closing,
    buyerCeilingFlip: flip.mao,
    fee,
    yourMaoFlip: flip.offer,
  };

  // Governing lane: the higher dispo ceiling wins (the exit is whichever
  // buyer class pays more). Landlord ceiling = Investor_MAO_V21.
  const landlordCeiling = usable(inputs.investorMaoV21) ? Math.round(inputs.investorMaoV21) : null;
  let buyerCeiling: number | null = null;
  let ceilingLane: CeilingLane = null;
  let yourMao: number | null = null;
  if (flip.mao != null && (landlordCeiling == null || flip.mao >= landlordCeiling)) {
    buyerCeiling = flip.mao;
    ceilingLane = "flip";
    yourMao = flip.offer;
  } else if (landlordCeiling != null) {
    buyerCeiling = landlordCeiling;
    ceilingLane = "landlord";
    yourMao = usable(inputs.yourMaoV21) ? Math.round(inputs.yourMaoV21) : landlordCeiling - fee;
  }

  const dealSpread = buyerCeiling != null && currentPrice != null ? buyerCeiling - currentPrice : null;
  const allInPctArv =
    usable(inputs.arv) && currentPrice != null && inputs.rehabMid != null && Number.isFinite(inputs.rehabMid)
      ? Math.round(((currentPrice + Math.max(0, inputs.rehabMid)) / inputs.arv) * 1000) / 1000
      : null;

  const base = {
    buyerCeiling,
    ceilingLane,
    dealSpread,
    allInPctArv,
    yourMao,
    currentPrice,
    priceSource,
    confidence,
    waterfall,
    inputsHash,
  };

  // ── NEEDS_DATA — the math cannot exist yet. Name exactly what's missing.
  const missing: string[] = [];
  if (!usable(inputs.arv)) missing.push("ARV (run comps)");
  if (inputs.rehabMid == null || !Number.isFinite(inputs.rehabMid)) missing.push("rehab estimate");
  if (currentPrice == null) missing.push("a price on record (no contract/counter/opener)");
  if (missing.length > 0) {
    return {
      ...base,
      verdict: "NEEDS_DATA",
      reason: `Missing: ${missing.join(", ")}. No verdict until the math is real — never guessed.`,
    };
  }

  // ── HOLD_LOW_CONF — computable but below the trust cutline.
  if (inputs.rehabConfidenceScore != null && inputs.rehabConfidenceScore < VISION_CONF_CUTLINE) {
    return {
      ...base,
      verdict: "HOLD_LOW_CONF",
      reason: `Rehab vision confidence ${Math.round(inputs.rehabConfidenceScore)} < ${VISION_CONF_CUTLINE} cutline — verify condition (photos/walkthrough) before trusting the spread.`,
    };
  }
  if (inputs.arvConfidence === "LOW") {
    return {
      ...base,
      verdict: "HOLD_LOW_CONF",
      reason: "ARV confidence LOW (<3 comps) — manual comp review before trusting the spread.",
    };
  }

  // ── The margin call. PASS reasons checked first (any one kills it).
  const price = currentPrice as number;
  const spread = dealSpread as number;
  const kills: string[] = [];
  if (spread < SPREAD_FLOOR_USD) kills.push(`spread $${spread.toLocaleString()} < $${SPREAD_FLOOR_USD.toLocaleString()} floor`);
  if (yourMao != null && price > yourMao) kills.push(`price $${price.toLocaleString()} > MAO $${yourMao.toLocaleString()}`);
  if (allInPctArv != null && allInPctArv > ALL_IN_MAX) kills.push(`all-in ${(allInPctArv * 100).toFixed(1)}% of ARV > ${ALL_IN_MAX * 100}%`);
  if (kills.length > 0) {
    return { ...base, verdict: "PASS", reason: `Doesn't clear: ${kills.join("; ")}.` };
  }

  if (spread >= SPREAD_TARGET_USD) {
    return {
      ...base,
      verdict: "GO",
      reason: `Clears: $${spread.toLocaleString()} spread at $${price.toLocaleString()} (${priceSource}), ceiling $${(buyerCeiling as number).toLocaleString()} (${ceilingLane}).`,
    };
  }
  return {
    ...base,
    verdict: "TIGHT",
    reason: `Thin: $${spread.toLocaleString()} spread (floor $${SPREAD_FLOOR_USD.toLocaleString()}, target $${SPREAD_TARGET_USD.toLocaleString()}) at $${price.toLocaleString()} (${priceSource}).`,
  };
}
