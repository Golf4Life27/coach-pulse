// INV-023 Pre-EMD gate — the runtime BLOCK. Smoke tests (Milestone 2).
//
// Proves the cardinal property: BLOCKED by default; every check BLOCKS on an
// absent input (the missing input named); the 23 Fields contract-vs-MAO guard
// fires; the advance action is refused unless ADVANCE_UNLOCKED; and a green
// verdict yields ADVANCE_UNLOCKED WITHOUT executing any advance (verdict only,
// zero network).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluatePreEmdGate,
  emdAdvanceDecision,
  type PreEmdGateInput,
} from "./pre-emd-gate";
import { proveNoNetwork } from "./dry-run-trace";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "pre-emd");
const NOW = new Date("2026-06-16T12:00:00.000Z");

function fx(name: string): { input: PreEmdGateInput; expect: Record<string, unknown> } {
  const j = JSON.parse(readFileSync(join(DIR, name), "utf8"));
  return { input: { ...j.input, now: NOW }, expect: j.expect };
}

describe("INV-023 Pre-EMD gate (Milestone 2)", () => {
  it("default-BLOCKED: an empty input blocks every one of the 9 checks", () => {
    const r = evaluatePreEmdGate({ recordId: "fixture:empty", now: NOW });
    expect(r.verdict).toBe("BLOCKED");
    expect(r.checks).toHaveLength(9);
    expect(r.blocked).toEqual(["DD-1", "DD-2", "DD-3", "DD-4", "DD-5", "DD-6", "DD-7", "DD-8", "DD-9"]);
    // every BLOCKED check names the input it needed
    for (const c of r.checks) {
      expect(c.status).toBe("BLOCKED");
      expect(c.neededInput && c.neededInput.length).toBeGreaterThan(0);
    }
  });

  it("23 Fields Ave → BLOCKED, and ONLY on the contract-vs-MAO check (DD-4)", () => {
    const { input } = fx("23-fields-ave.json");
    const r = evaluatePreEmdGate(input);
    expect(r.verdict).toBe("BLOCKED");
    expect(r.blocked).toEqual(["DD-4"]);
    const dd4 = r.checks.find((c) => c.id === "DD-4")!;
    expect(dd4.status).toBe("BLOCKED");
    // the literal 23 Fields numbers: $61,750 contract > $45,000 Your_MAO
    expect(dd4.reason).toContain("61,750");
    expect(dd4.reason).toContain("45,000");
    expect(dd4.examined.your_mao).toBe(45000);
  });

  it("Poteet 938 Avenue I → BLOCKED on un-validated ARV, missing rehab, absent buyer ceiling, unconfirmed assignment (+ more); only DD-8 passes", () => {
    const { input } = fx("poteet-938-avenue-i.json");
    const r = evaluatePreEmdGate(input);
    expect(r.verdict).toBe("BLOCKED");
    for (const id of ["DD-1", "DD-2", "DD-3", "DD-4", "DD-5", "DD-6", "DD-7", "DD-9"]) {
      expect(r.blocked).toContain(id);
    }
    // TX is not restricted → DD-8 is the one green check.
    expect(r.checks.find((c) => c.id === "DD-8")!.status).toBe("pass");
    // un-validated (broker) ARV is explicitly refused, not silently accepted.
    expect(r.checks.find((c) => c.id === "DD-1")!.reason).toMatch(/not validated|broker|AVM/i);
  });

  it("fully-populated, in-bounds → ADVANCE_UNLOCKED", () => {
    const { input } = fx("fully-populated-pass.json");
    const r = evaluatePreEmdGate(input);
    expect(r.verdict).toBe("ADVANCE_UNLOCKED");
    expect(r.blocked).toEqual([]);
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
  });

  // ── Table-driven: clearing ANY single required input blocks that check ──
  const PASS = fx("fully-populated-pass.json").input;
  const cases: Array<{ check: string; mutate: Partial<PreEmdGateInput> }> = [
    { check: "DD-1", mutate: { arvValue: null } },
    { check: "DD-1", mutate: { arvValidatedFromComps: false } }, // broker/AVM ARV
    { check: "DD-2", mutate: { estRehab: null, estRehabHigh: null } },
    { check: "DD-3", mutate: { buyerMedian: null } },
    { check: "DD-4", mutate: { contractPrice: 999999 } }, // contract > Your_MAO
    { check: "DD-5", mutate: { assignmentClauseVerified: false, doubleCloseCapitalConfirmed: false } },
    { check: "DD-6", mutate: { photosValidated: false } },
    { check: "DD-7", mutate: { availabilityConfirmedAt: null } },
    { check: "DD-8", mutate: { state: "NC" } }, // restricted state
    { check: "DD-9", mutate: { operatorSignoff: false } },
  ];
  for (const { check, mutate } of cases) {
    it(`${check} BLOCKS when its input is absent/invalid (${Object.keys(mutate).join(",")})`, () => {
      const r = evaluatePreEmdGate({ ...PASS, ...mutate, now: NOW });
      expect(r.verdict).toBe("BLOCKED");
      expect(r.blocked).toContain(check);
    });
  }

  // ── The advance action is refused unless ADVANCE_UNLOCKED ──────────────
  it("emdAdvanceDecision refuses a BLOCKED record and allows only an unlocked one", () => {
    const blocked = evaluatePreEmdGate(fx("23-fields-ave.json").input);
    const refused = emdAdvanceDecision(blocked);
    expect(refused.allowed).toBe(false);
    expect(refused.httpStatus).toBe(423);
    expect(refused.blocked_checks.map((c) => c.id)).toContain("DD-4");

    const unlocked = evaluatePreEmdGate(fx("fully-populated-pass.json").input);
    const allowed = emdAdvanceDecision(unlocked);
    expect(allowed.allowed).toBe(true);
  });

  it("evaluation + advance-decision are verdict-only: zero network, no side effects", () => {
    const { fetchCalls } = proveNoNetwork(() => {
      const r = evaluatePreEmdGate(fx("fully-populated-pass.json").input);
      // ADVANCE_UNLOCKED yields only a DECISION; nothing is executed here.
      return emdAdvanceDecision(r).allowed;
    });
    expect(fetchCalls).toBe(0);
  });
});
