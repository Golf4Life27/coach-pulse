// preContractOperatorHandoff — unit tests.
// Proves the belt reaches the operator CLEANLY at the contract wall:
// DocuSign-unwired → surface to operator (Manual Review); a real rule
// failure → blocked (never a clean hand-off); both fail-closed (no advance).

import { describe, it, expect } from "vitest";
import { preContractOperatorHandoff } from "./pre-contract-handoff";
import type { GateRunResult } from "./types";

function mkResult(over: Partial<GateRunResult>): GateRunResult {
  return {
    gate_id: "pre_contract",
    recordId: "rec0000000000TEST",
    stage_from: "negotiating",
    stage_to: "under_contract",
    current_stage: "negotiating",
    overall_status: "fail",
    results: [],
    blockers: [],
    warnings: [],
    data_missing: [],
    computed_at: "2026-06-18T00:00:00.000Z",
    elapsed_ms: 1,
    ...over,
  };
}

describe("preContractOperatorHandoff", () => {
  it("DocuSign unwired (only data_missing) → surface to operator, Manual Review", () => {
    const h = preContractOperatorHandoff(
      mkResult({ data_missing: ["PC-01", "PC-08", "PC-22"], blockers: [] }),
    );
    expect(h.surfaceToOperator).toBe(true);
    expect(h.outreachStatus).toBe("Manual Review");
    expect(h.reason).toBe("awaiting_operator_signature");
    expect(h.pendingData).toEqual(["PC-01", "PC-08", "PC-22"]);
  });

  it("genuine rule failure → blocked_by_rule, NOT surfaced, never advanced", () => {
    const h = preContractOperatorHandoff(
      mkResult({ blockers: ["PC-16"], data_missing: ["PC-01"] }),
    );
    expect(h.surfaceToOperator).toBe(false);
    expect(h.outreachStatus).toBeNull();
    expect(h.reason).toBe("blocked_by_rule");
    expect(h.realBlockers).toEqual(["PC-16"]);
  });

  it("called on a non-pre_contract gate → no-op", () => {
    const h = preContractOperatorHandoff(mkResult({ gate_id: "pre_outreach" }));
    expect(h.surfaceToOperator).toBe(false);
    expect(h.reason).toBe("not_pre_contract");
  });

  it("defensive: a pass needs no hand-off", () => {
    const h = preContractOperatorHandoff(
      mkResult({ overall_status: "pass", blockers: [], data_missing: [] }),
    );
    expect(h.surfaceToOperator).toBe(false);
    expect(h.reason).toBe("passed_no_handoff_needed");
  });
});
