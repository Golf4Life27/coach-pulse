// Pre-Contract math gate — INV-023 (Spine recUS0oHqXLtEM3lG Track A).
// @agent: orchestrator
//
// The math that hard-blocks advancement into `Pipeline_Stage = under_contract`.
// Per the V1 build authorization:
//
//   Investor_MAO = Buyer_Median − Est_Rehab
//   Your_MAO     = Investor_MAO − Wholesale_Fee
//
// All three preconditions (CMA fresh, Buyer_Median present, MAO clean)
// must be GREEN. Missing data → HOLD (data_missing). No override path.
//
// Pure helpers + a single-call gate evaluator. The orchestrator wires
// this into Gate 4 (pre-contract) as PC-25/PC-26/PC-27.

/** Default wholesale fee in dollars. Operator-locked 2026-06-03 (Spine
 *  `rec937cFJthvCZzBM`) — reduced from $15K to $5K to match the actual
 *  fee-per-deal target. Other modules that need a fee default (e.g.
 *  `lib/appraiser/mao-range.ts:DEFAULT_WHOLESALE_FEE`) still carry the
 *  legacy $15K bible-default; those are out-of-scope for this cycle and
 *  flagged for follow-up reconciliation. */
export const DEFAULT_WHOLESALE_FEE = 5_000;

/** Default CMA freshness threshold in days. Matches the existing
 *  Gate 5 (PE-01) staleness rule. */
export const DEFAULT_CMA_STALENESS_DAYS = 7;

export interface PreContractMathInputs {
  /** Contract price being evaluated for `under_contract` advancement. */
  contractOfferPrice: number | null | undefined;
  /** Buyer_Median from Property_Intel (INV-022). Per Decision Preconditions
   *  Rule 1 this is the V2.1 floor truth signal — NO theoretical fallback. */
  buyerMedian: number | null | undefined;
  /** Est_Rehab in dollars (Phase 4B vision/manual). */
  estRehab: number | null | undefined;
  /** Wholesale fee in dollars. Defaults to DEFAULT_WHOLESALE_FEE if omitted. */
  wholesaleFee?: number | null | undefined;
  /** ISO timestamp when the CMA was last validated (`arvValidatedAt`). */
  cmaValidatedAt: string | null | undefined;
  /** CMA staleness threshold in days. Defaults to DEFAULT_CMA_STALENESS_DAYS. */
  cmaStalenessDays?: number;
  /** Current time injected for tests; defaults to `new Date()`. */
  now?: Date;
}

export type MathPreconditionStatus = "pass" | "hold" | "block";

export interface MathPreconditionResult {
  status: MathPreconditionStatus;
  reason: string;
}

export interface PreContractMathResult {
  /** Aggregate gate verdict. `pass` only when every precondition passes. */
  status: MathPreconditionStatus;
  /** Investor_MAO = Buyer_Median − Est_Rehab. null when inputs missing. */
  investorMao: number | null;
  /** Your_MAO = Investor_MAO − Wholesale_Fee. null when inputs missing. */
  yourMao: number | null;
  /** Wholesale fee actually used in the computation. */
  wholesaleFeeUsed: number;
  /** Per-precondition breakdown. */
  cma: MathPreconditionResult;
  buyerMedian: MathPreconditionResult;
  mao: MathPreconditionResult;
  /** Human-readable summary suitable for the gate-runner's `reasoning`. */
  message: string;
}

/** Pure: Investor_MAO = Buyer_Median − Est_Rehab. Returns null on missing
 *  inputs; returns a possibly-negative number when both inputs present. */
export function computeInvestorMao(
  buyerMedian: number | null | undefined,
  estRehab: number | null | undefined,
): number | null {
  if (buyerMedian == null || !Number.isFinite(buyerMedian) || buyerMedian <= 0) {
    return null;
  }
  if (estRehab == null || !Number.isFinite(estRehab) || estRehab < 0) {
    return null;
  }
  return Math.round(buyerMedian - estRehab);
}

/** Pure: Your_MAO = Investor_MAO − Wholesale_Fee. Returns null on missing
 *  inputs; returns a possibly-negative number when both inputs present. */
export function computeYourMao(
  investorMao: number | null,
  wholesaleFee: number,
): number | null {
  if (investorMao == null || !Number.isFinite(investorMao)) return null;
  if (!Number.isFinite(wholesaleFee) || wholesaleFee < 0) return null;
  return Math.round(investorMao - wholesaleFee);
}

const DAY_MS = 86_400_000;

/**
 * Pure: evaluate the three preconditions against one record's inputs.
 *
 * Status semantics:
 *   - `pass`  — every precondition passed.
 *   - `hold`  — at least one precondition is `data_missing` (retry-able;
 *               no operator surface per Constitution Rule 3).
 *   - `block` — at least one precondition failed AND no precondition
 *               is data_missing (the math is decisive: spread negative
 *               or contract > Your_MAO). Type 2C surface — no override.
 *
 * `block` wins over `hold` when contract price exceeds Your_MAO even if
 * other preconditions are missing — the math is already decisive against
 * the deal and surfacing it gives the operator the right diagnosis.
 * `hold` wins over `pass` otherwise — never auto-pass on missing data.
 */
export function evaluatePreContractMath(
  inputs: PreContractMathInputs,
): PreContractMathResult {
  const fee =
    inputs.wholesaleFee == null || !Number.isFinite(inputs.wholesaleFee) || inputs.wholesaleFee < 0
      ? DEFAULT_WHOLESALE_FEE
      : inputs.wholesaleFee;
  const stalenessDays =
    inputs.cmaStalenessDays && inputs.cmaStalenessDays > 0
      ? inputs.cmaStalenessDays
      : DEFAULT_CMA_STALENESS_DAYS;
  const now = inputs.now ?? new Date();

  // PC-25: CMA fresh.
  const cma = evaluateCma(inputs.cmaValidatedAt, stalenessDays, now);

  // PC-26: Buyer_Median present.
  const buyerMedian = evaluateBuyerMedian(inputs.buyerMedian);

  // PC-27: MAO math.
  const investorMao = computeInvestorMao(inputs.buyerMedian, inputs.estRehab);
  const yourMao = computeYourMao(investorMao, fee);
  const mao = evaluateMao(inputs.contractOfferPrice, investorMao, yourMao, inputs.buyerMedian, inputs.estRehab, fee);

  // Aggregate.
  let status: MathPreconditionStatus = "pass";
  // block wins over hold when ANY precondition blocks.
  if (cma.status === "block" || buyerMedian.status === "block" || mao.status === "block") {
    status = "block";
  } else if (cma.status === "hold" || buyerMedian.status === "hold" || mao.status === "hold") {
    status = "hold";
  }

  const message = renderMessage(status, cma, buyerMedian, mao, investorMao, yourMao);

  return {
    status,
    investorMao,
    yourMao,
    wholesaleFeeUsed: fee,
    cma,
    buyerMedian,
    mao,
    message,
  };
}

function evaluateCma(
  validatedAt: string | null | undefined,
  stalenessDays: number,
  now: Date,
): MathPreconditionResult {
  if (!validatedAt) {
    return { status: "hold", reason: "CMA absent — arvValidatedAt unset (comps never validated)." };
  }
  const t = Date.parse(validatedAt);
  if (Number.isNaN(t)) {
    return { status: "hold", reason: `CMA timestamp unparseable: "${validatedAt}".` };
  }
  const ageDays = (now.getTime() - t) / DAY_MS;
  if (ageDays > stalenessDays) {
    return {
      status: "hold",
      reason: `CMA stale — validated ${ageDays.toFixed(1)}d ago (>${stalenessDays}d threshold). Re-run ARV.`,
    };
  }
  return { status: "pass", reason: `CMA fresh (validated ${ageDays.toFixed(1)}d ago).` };
}

function evaluateBuyerMedian(bm: number | null | undefined): MathPreconditionResult {
  if (bm == null || !Number.isFinite(bm) || bm <= 0) {
    return {
      status: "hold",
      reason: "Buyer_Median absent — Property_Intel.Buyer_Median_Value null/≤0. INV-022 hydration required.",
    };
  }
  return { status: "pass", reason: `Buyer_Median present: $${Math.round(bm).toLocaleString()}.` };
}

function evaluateMao(
  contractOfferPrice: number | null | undefined,
  investorMao: number | null,
  yourMao: number | null,
  buyerMedian: number | null | undefined,
  estRehab: number | null | undefined,
  wholesaleFee: number,
): MathPreconditionResult {
  // Missing inputs first: math can't be computed at all.
  if (investorMao == null || yourMao == null) {
    const missing: string[] = [];
    if (buyerMedian == null || !Number.isFinite(buyerMedian) || buyerMedian <= 0) missing.push("Buyer_Median");
    if (estRehab == null || !Number.isFinite(estRehab) || estRehab < 0) missing.push("Est_Rehab");
    return {
      status: "hold",
      reason: `MAO inputs incomplete (missing ${missing.join(" + ") || "Buyer_Median + Est_Rehab"}). Hydrate before advancing.`,
    };
  }

  // Decisive structural blocks: contract price always evaluated against
  // Your_MAO (the most conservative number — your max BEFORE the spread).
  if (contractOfferPrice == null || !Number.isFinite(contractOfferPrice) || contractOfferPrice <= 0) {
    // No contract price yet means we can't compare; treat as hold (the
    // operator hasn't proposed terms yet).
    return {
      status: "hold",
      reason: `Contract_Offer_Price unset — can't evaluate against Your_MAO=$${yourMao.toLocaleString()} yet.`,
    };
  }
  if (yourMao <= 0) {
    return {
      status: "block",
      reason: `Spread is negative — Investor_MAO=$${investorMao.toLocaleString()}, Your_MAO=$${yourMao.toLocaleString()} (Buyer_Median=$${(buyerMedian as number).toLocaleString()} − Est_Rehab=$${(estRehab as number).toLocaleString()} − Wholesale_Fee=$${wholesaleFee.toLocaleString()}). Deal math does not work.`,
    };
  }
  if (contractOfferPrice > yourMao) {
    return {
      status: "block",
      reason: `Contract_Offer_Price=$${contractOfferPrice.toLocaleString()} > Your_MAO=$${yourMao.toLocaleString()} (Investor_MAO=$${investorMao.toLocaleString()}, Wholesale_Fee=$${wholesaleFee.toLocaleString()}). Deal math does not pass.`,
    };
  }
  return {
    status: "pass",
    reason: `Contract_Offer_Price=$${contractOfferPrice.toLocaleString()} ≤ Your_MAO=$${yourMao.toLocaleString()} (Investor_MAO=$${investorMao.toLocaleString()}, Wholesale_Fee=$${wholesaleFee.toLocaleString()}).`,
  };
}

function renderMessage(
  status: MathPreconditionStatus,
  cma: MathPreconditionResult,
  buyerMedian: MathPreconditionResult,
  mao: MathPreconditionResult,
  investorMao: number | null,
  yourMao: number | null,
): string {
  if (status === "pass") {
    return `Pre-contract math GREEN. Investor_MAO=$${investorMao?.toLocaleString()}, Your_MAO=$${yourMao?.toLocaleString()}.`;
  }
  if (status === "block") {
    const blockers = [cma, buyerMedian, mao].filter((r) => r.status === "block").map((r) => r.reason);
    return `Pre-contract math BLOCKED — ${blockers.join(" | ")}`;
  }
  // hold
  const holds = [cma, buyerMedian, mao].filter((r) => r.status === "hold").map((r) => r.reason);
  return `Pre-contract math HOLD — ${holds.join(" | ")}`;
}
