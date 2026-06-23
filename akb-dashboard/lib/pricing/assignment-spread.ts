// Dispo assignment-spread gate — the SELL-side bookend to the INV-023
// pre-contract (BUY-side) math. @agent: appraiser/dispo
//
// pre-contract-math guarantees you never CONTRACT above Your_MAO. This
// guarantees you never ASSIGN below what clears that contract plus your fee —
// the structural fix for "5 contracts I couldn't dispo because they were too
// tight." A buyer price that doesn't cover contract + fee is a money-loser;
// the gate BLOCKS it (operator-overridable at the route, never auto-overridden).
//
//   assignment_floor = contract_price + wholesale_fee
//   realized_spread  = assignment_price − contract_price        (your take)
//   PASS  ⟺  assignment_price ≥ assignment_floor   (realized_spread ≥ fee)
//
// Pure. No I/O. Mirrors pre-contract-math's pass/hold/block semantics so the
// BUY and SELL gates read the same way in the orchestrator:
//   - pass  — the spread clears the fee.
//   - hold  — a price is missing (retry-able; no decision yet).
//   - block — decisive money-loser (assignment < contract + fee).

import { DEFAULT_WHOLESALE_FEE } from "@/lib/pre-contract-math";

export type AssignmentSpreadStatus = "pass" | "hold" | "block";

export interface AssignmentSpreadInputs {
  /** What we ask the cash buyer to pay (the assignment price). */
  assignmentPrice: number | null | undefined;
  /** What we owe the seller — the price we're under contract for. */
  contractPrice: number | null | undefined;
  /** Our required fee in dollars. Defaults to DEFAULT_WHOLESALE_FEE ($5K). */
  wholesaleFee?: number | null | undefined;
}

export interface AssignmentSpreadResult {
  status: AssignmentSpreadStatus;
  /** Minimum assignment price that clears contract + fee. null if contract unknown. */
  assignmentFloor: number | null;
  /** assignment − contract (your take before costs). null if either price unknown. */
  realizedSpread: number | null;
  /** Fee actually used in the computation. */
  wholesaleFeeUsed: number;
  /** Human-readable verdict, suitable for an audit row or a route error body. */
  reason: string;
}

/** A usable, positive dollar figure. */
function positive(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n) && n > 0;
}

/** Pure: does this assignment clear contract + fee? Never throws. */
export function evaluateAssignmentSpread(
  inputs: AssignmentSpreadInputs,
): AssignmentSpreadResult {
  const fee =
    inputs.wholesaleFee == null || !Number.isFinite(inputs.wholesaleFee) || inputs.wholesaleFee < 0
      ? DEFAULT_WHOLESALE_FEE
      : inputs.wholesaleFee;

  // Contract price missing → can't evaluate at all (hold, never block).
  if (!positive(inputs.contractPrice)) {
    return {
      status: "hold",
      assignmentFloor: null,
      realizedSpread: null,
      wholesaleFeeUsed: fee,
      reason: "Contract price unknown — resolve the under-contract price before evaluating the assignment spread.",
    };
  }
  const contractPrice = inputs.contractPrice;
  const assignmentFloor = Math.round(contractPrice + fee);

  // Assignment price not yet set → hold, but surface the floor so the
  // operator knows the number to clear.
  if (!positive(inputs.assignmentPrice)) {
    return {
      status: "hold",
      assignmentFloor,
      realizedSpread: null,
      wholesaleFeeUsed: fee,
      reason: `Assignment price unset — must be ≥ $${assignmentFloor.toLocaleString()} (contract $${Math.round(contractPrice).toLocaleString()} + fee $${fee.toLocaleString()}).`,
    };
  }
  const assignmentPrice = inputs.assignmentPrice;
  const realizedSpread = Math.round(assignmentPrice - contractPrice);

  // Decisive money-loser → block.
  if (assignmentPrice < assignmentFloor) {
    return {
      status: "block",
      assignmentFloor,
      realizedSpread,
      wholesaleFeeUsed: fee,
      reason: `Assignment $${Math.round(assignmentPrice).toLocaleString()} < floor $${assignmentFloor.toLocaleString()} (contract $${Math.round(contractPrice).toLocaleString()} + fee $${fee.toLocaleString()}). Realized spread $${realizedSpread.toLocaleString()} < required fee $${fee.toLocaleString()} — too tight to dispo.`,
    };
  }

  return {
    status: "pass",
    assignmentFloor,
    realizedSpread,
    wholesaleFeeUsed: fee,
    reason: `Assignment $${Math.round(assignmentPrice).toLocaleString()} ≥ floor $${assignmentFloor.toLocaleString()}. Realized spread $${realizedSpread.toLocaleString()} ≥ fee $${fee.toLocaleString()}.`,
  };
}
