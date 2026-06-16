// INV-023 — Pre-EMD Due-Diligence Gate (the runtime BLOCK). Milestone 2.
// @agent: orchestrator
//
// THE CARDINAL SAFETY PROPERTY: this gate is BLOCKED by default. A check
// turns green ONLY when a REAL, validated value satisfies it.
//   - Absence of data = BLOCKED, with the specific missing input named.
//   - Never fabricate a value to pass a check (the 23 Fields / 80%-MAO rule).
//   - Pessimistic on low confidence — fail to the safe side.
//   - The gate does NOT fetch missing data; its job is to BLOCK on absence.
//     Expect it to BLOCK most records today — that is correct, not a bug.
//
// Verdict: ADVANCE_UNLOCKED only when ALL nine required checks pass;
// otherwise BLOCKED. This is the structural answer to the 23 Fields Ave
// failure (a $61,750 contract against a ~$45,000 buyer ceiling that nothing
// checked before the money moved) — check DD-4 is that comparison.
//
// PURE. No I/O — composes lib/pre-contract-math (DD-4 Investor/Your_MAO math)
// and lib/crawler/intake-filter.EXCLUDED_STATES (DD-8). Mirrors the M1
// gate-runner check pattern (pure functions → itemized results). The live
// EMD-advance action assembles a PreEmdGateInput from the Deal + Listing +
// Property_Intel and calls evaluatePreEmdGate(); see
// app/api/deals/request-emd/route.ts.

import { evaluatePreContractMath, DEFAULT_WHOLESALE_FEE } from "@/lib/pre-contract-math";
import { EXCLUDED_STATES } from "@/lib/crawler/intake-filter";
import type { ArvEngineResult } from "./arv-comp-engine";

export type CheckOutcome = "pass" | "BLOCKED";
export type Verdict = "ADVANCE_UNLOCKED" | "BLOCKED";

export interface PreEmdCheck {
  id: string;
  label: string;
  status: CheckOutcome;
  /** Literal pass/BLOCK reason. */
  reason: string;
  /** The real input this check needed (named) when BLOCKED; null when pass. */
  neededInput: string | null;
  examined: Record<string, unknown>;
}

export interface PreEmdGateResult {
  recordId: string;
  verdict: Verdict;
  checks: PreEmdCheck[];
  /** ids of the BLOCKED checks (empty ⇒ ADVANCE_UNLOCKED). */
  blocked: string[];
  evaluatedAt: string;
}

/** Flat, fixture-friendly input. Every field defaults to the BLOCKING
 *  interpretation when absent. The live assembler maps Deal + Listing +
 *  Property_Intel onto this; a fixture supplies it directly. */
export interface PreEmdGateInput {
  recordId: string;
  // DD-1 ARV validated from renovated comps — AUTO-COMPLETED by the ARV Comp
  // Engine (Milestone 3). The operator no longer ticks this; DD-1 reads the
  // engine's decision (VALIDATED ⇒ pass; ESCALATE/BLOCKED ⇒ blocked). Null ⇒
  // engine not run / errored ⇒ BLOCKED (fail-closed).
  arvEngine?: ArvEngineResult | null;
  // DD-2 Rehab (pessimistic-bound). Low confidence ⇒ use the high end.
  estRehab?: number | null;
  estRehabHigh?: number | null;
  rehabConfidence?: "HIGH" | "MED" | "LOW" | string | null;
  rehabEstimatedAt?: string | null;
  // DD-3 Buyer ceiling.
  buyerMedian?: number | null;
  // DD-4 Contract ≤ Your_MAO (composes DD-2 pessimistic rehab + DD-3 + fee).
  contractPrice?: number | null;
  wholesaleFee?: number | null;
  // DD-5 Assignment.
  assignmentClauseVerified?: boolean;
  doubleCloseCapitalConfirmed?: boolean;
  // DD-6 Condition / photos.
  photosValidated?: boolean;
  // DD-7 Property still available (verify-before-act).
  liveStatus?: string | null;
  availabilityConfirmedAt?: string | null;
  // DD-8 Restricted-state / pause.
  state?: string | null;
  marketPaused?: boolean; // e.g. Memphis paused
  pauseExceptionApproved?: boolean;
  // DD-9 Operator sign-off.
  operatorSignoff?: boolean;
  now?: Date;
}

const HOUR_MS = 3_600_000;
const AVAILABILITY_STALENESS_HOURS = 72; // matches PO-02 freshness

const posNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The pessimistic (safe-side) rehab figure fed to DD-4: low/unknown
 *  confidence prefers the HIGH end of the band; HIGH confidence may use the
 *  point estimate. Never lower than the point estimate. */
export function pessimisticRehab(input: PreEmdGateInput): number | null {
  const mid = posNum(input.estRehab) ? input.estRehab : null;
  const high = posNum(input.estRehabHigh) ? input.estRehabHigh : null;
  const conf = (input.rehabConfidence ?? "").toUpperCase();
  if (conf === "HIGH") return mid ?? high;
  // Low/MED/unknown → pessimistic: prefer the high end, else the point.
  if (high != null && mid != null) return Math.max(high, mid);
  return high ?? mid;
}

export function evaluatePreEmdGate(input: PreEmdGateInput): PreEmdGateResult {
  const now = input.now ?? new Date();
  const checks: PreEmdCheck[] = [];
  const block = (id: string, label: string, reason: string, neededInput: string, examined: Record<string, unknown> = {}) =>
    checks.push({ id, label, status: "BLOCKED", reason, neededInput, examined });
  const pass = (id: string, label: string, reason: string, examined: Record<string, unknown> = {}) =>
    checks.push({ id, label, status: "pass", reason, neededInput: null, examined });

  // ── DD-1 ARV validated from renovated comps (ENGINE auto-completed) ──
  // Milestone 3: the ARV Comp Engine validates DD-1 — no operator tick. It
  // reads the engine's decision, NOT the contaminated stored ARV and NEVER a
  // RentCast AVM. VALIDATED ⇒ pass; ESCALATE ⇒ BLOCKED + routed to operator
  // (Manual Review); BLOCKED/absent ⇒ BLOCKED (fail-closed).
  {
    const L = "ARV validated from comps";
    const e = input.arvEngine;
    if (!e) {
      block("DD-1", L, "ARV comp engine produced no result — engine not run or errored (fail-closed).", "engine-validated ARV (ARV comp engine)", { arv_engine: null });
    } else if (e.decision === "VALIDATED") {
      if (!posNum(e.engineArv)) {
        block("DD-1", L, "ARV engine returned VALIDATED but no engine_arv — refusing (fail-closed).", "engine_arv", { arv_engine: e.decision });
      } else {
        pass("DD-1", L, `ARV $${e.engineArv.toLocaleString()} engine-validated from ${e.compCount ?? "?"} renovated comps (confidence ${e.confidence ?? "?"}, conservative low-end).`, { engine_arv: e.engineArv, comp_count: e.compCount, confidence: e.confidence, seed_tier: e.seedTier, source: e.source });
      }
    } else if (e.decision === "ESCALATE") {
      block("DD-1", L, `ARV escalated to operator (Manual Review) — not auto-validated: ${e.reason}`, "operator review of the escalated ARV (Type 2C)", { arv_engine: "ESCALATE", reason: e.reason, partial_arv: e.engineArv });
    } else {
      block("DD-1", L, `ARV blocked — ${e.reason}`, "a STRONG renovated-comp seed for the ZIP", { arv_engine: "BLOCKED", reason: e.reason });
    }
  }

  // ── DD-2 Rehab estimated (pessimistic-bound) ─────────────────────────
  {
    const L = "Rehab estimated (pessimistic-bound)";
    const rehab = pessimisticRehab(input);
    if (rehab == null) {
      block("DD-2", L, "No rehab estimate on record — vision/manual rehab never ran.", "Est_Rehab (pessimistic high-end)", { est_rehab: input.estRehab ?? null, est_rehab_high: input.estRehabHigh ?? null });
    } else if (!input.rehabEstimatedAt) {
      block("DD-2", L, "Rehab has no estimate timestamp — provenance unknown.", "rehabEstimatedAt", { rehab });
    } else {
      const conf = (input.rehabConfidence ?? "").toUpperCase();
      const usedHigh = conf !== "HIGH" && posNum(input.estRehabHigh);
      pass("DD-2", L, `Rehab $${rehab.toLocaleString()} (${input.rehabConfidence ?? "confidence?"})${usedHigh ? " — low-confidence ⇒ pessimistic high-end used" : ""}.`, { rehab_used: rehab, confidence: input.rehabConfidence ?? null });
    }
  }

  // ── DD-3 Buyer ceiling present ───────────────────────────────────────
  {
    const L = "Buyer ceiling present";
    if (!posNum(input.buyerMedian)) {
      block("DD-3", L, "Buyer_Median absent — no validated buyer ceiling for this market (Property_Intel / Buyer_Median_ZIP not hydrated).", "Buyer_Median", { buyer_median: input.buyerMedian ?? null });
    } else {
      pass("DD-3", L, `Buyer_Median present: $${input.buyerMedian.toLocaleString()}.`, { buyer_median: input.buyerMedian });
    }
  }

  // ── DD-4 Contract price ≤ Your_MAO (the 23 Fields check) ─────────────
  // Composes lib/pre-contract-math with the PESSIMISTIC rehab. Any non-pass
  // (missing inputs OR contract > Your_MAO OR negative spread) ⇒ BLOCKED.
  {
    const L = "Contract price ≤ Your_MAO";
    const fee = posNum(input.wholesaleFee) ? input.wholesaleFee : DEFAULT_WHOLESALE_FEE;
    const math = evaluatePreContractMath({
      contractOfferPrice: input.contractPrice ?? null,
      buyerMedian: input.buyerMedian ?? null,
      estRehab: pessimisticRehab(input),
      wholesaleFee: fee,
      cmaValidatedAt: input.arvEngine?.freshness.fetchedAt ?? null,
      now,
    });
    if (math.mao.status !== "pass") {
      block("DD-4", L, math.mao.reason, "Contract_Offer_Price ≤ Your_MAO (with real Buyer_Median + Est_Rehab)", { investor_mao: math.investorMao, your_mao: math.yourMao, wholesale_fee: fee, contract_price: input.contractPrice ?? null });
    } else {
      pass("DD-4", L, math.mao.reason, { investor_mao: math.investorMao, your_mao: math.yourMao, contract_price: input.contractPrice });
    }
  }

  // ── DD-5 Assignment confirmed ────────────────────────────────────────
  {
    const L = "Assignment confirmed";
    if (input.assignmentClauseVerified === true) {
      pass("DD-5", L, "Assignment clause verified — operator confirmed assignment is not prohibited in this contract.");
    } else if (input.doubleCloseCapitalConfirmed === true) {
      pass("DD-5", L, "Double-close capital explicitly flagged — assignment not required for this deal.");
    } else {
      block("DD-5", L, "Assignment not confirmed — the contract may prohibit assignment and no double-close capital is flagged. Unknown/restricted = BLOCKED.", "Assignment-clause verification OR double-close capital flag", { assignment_clause_verified: input.assignmentClauseVerified ?? false, double_close_capital: input.doubleCloseCapitalConfirmed ?? false });
    }
  }

  // ── DD-6 Condition / photos verified ─────────────────────────────────
  {
    const L = "Condition/photos verified";
    if (input.photosValidated === true) {
      pass("DD-6", L, "Condition/photos validated against the rehab basis.");
    } else {
      block("DD-6", L, "Condition/photos not verified — rehab basis unconfirmed (missing kitchen photos ⇒ assume gut).", "Condition/photos validation", { photos_validated: input.photosValidated ?? false });
    }
  }

  // ── DD-7 Property still available (verify-before-act) ────────────────
  {
    const L = "Property still available";
    const status = (input.liveStatus ?? "").trim().toLowerCase();
    if (status !== "active") {
      block("DD-7", L, `Availability not confirmed — Live_Status is "${input.liveStatus ?? "unset"}" (must be Active).`, "Live_Status=Active", { live_status: input.liveStatus ?? null });
    } else if (!input.availabilityConfirmedAt) {
      block("DD-7", L, "No availability-verification timestamp — verify-before-act not satisfied.", "fresh availability confirmation", {});
    } else {
      const t = Date.parse(input.availabilityConfirmedAt);
      const ageH = Number.isNaN(t) ? NaN : (now.getTime() - t) / HOUR_MS;
      if (Number.isNaN(ageH)) {
        block("DD-7", L, `Availability timestamp unparseable: "${input.availabilityConfirmedAt}".`, "valid availability timestamp", {});
      } else if (ageH > AVAILABILITY_STALENESS_HOURS) {
        block("DD-7", L, `Availability stale — last verified ${ageH.toFixed(0)}h ago (>${AVAILABILITY_STALENESS_HOURS}h). Re-verify before EMD.`, "re-verified availability", { age_hours: Number(ageH.toFixed(1)) });
      } else {
        pass("DD-7", L, `Active, verified ${ageH.toFixed(0)}h ago.`, { live_status: input.liveStatus });
      }
    }
  }

  // ── DD-8 Restricted-state / pause check ──────────────────────────────
  {
    const L = "Restricted-state / pause check";
    const st = (input.state ?? "").trim().toUpperCase();
    if (!st) {
      block("DD-8", L, "State unset — cannot confirm the property is not in a restricted/paused market.", "State", { state: null });
    } else if (EXCLUDED_STATES.has(st)) {
      block("DD-8", L, `State ${st} is permanently excluded (IL/MO/SC/NC/OK/ND).`, "non-excluded state", { state: st });
    } else if (input.marketPaused === true && input.pauseExceptionApproved !== true) {
      block("DD-8", L, "Market is PAUSED (e.g. Memphis) — an explicit operator pause-exception is required.", "pause-exception approval", { state: st, market_paused: true });
    } else {
      pass("DD-8", L, `State ${st} not restricted${input.marketPaused ? " (paused market, exception approved)" : ""}.`, { state: st });
    }
  }

  // ── DD-9 Operator sign-off ───────────────────────────────────────────
  {
    const L = "Operator sign-off";
    if (input.operatorSignoff === true) {
      pass("DD-9", L, "Final operator sign-off recorded.");
    } else {
      block("DD-9", L, "Operator sign-off absent — final human approval required before EMD (Lost-Phone Test).", "Operator sign-off", { operator_signoff: input.operatorSignoff ?? false });
    }
  }

  const blocked = checks.filter((c) => c.status === "BLOCKED").map((c) => c.id);
  return {
    recordId: input.recordId,
    verdict: blocked.length === 0 ? "ADVANCE_UNLOCKED" : "BLOCKED",
    checks,
    blocked,
    evaluatedAt: now.toISOString(),
  };
}

/** The advance-action decision: an EMD/contract advance is refused unless the
 *  gate verdict is ADVANCE_UNLOCKED. Shared by the route + tests so the
 *  refuse-logic has one home. Returns the HTTP-ish decision for the caller. */
export function emdAdvanceDecision(result: PreEmdGateResult): {
  allowed: boolean;
  httpStatus: number;
  reason: string;
  blocked_checks: Array<{ id: string; reason: string; neededInput: string | null }>;
} {
  if (result.verdict === "ADVANCE_UNLOCKED") {
    return { allowed: true, httpStatus: 200, reason: "pre_emd_gate_advance_unlocked", blocked_checks: [] };
  }
  return {
    allowed: false,
    httpStatus: 423, // Locked
    reason: "pre_emd_gate_blocked",
    blocked_checks: result.checks
      .filter((c) => c.status === "BLOCKED")
      .map((c) => ({ id: c.id, reason: c.reason, neededInput: c.neededInput })),
  };
}
