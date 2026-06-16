// INV-023 live wiring — proves a BLOCKED record cannot advance through the
// EMD action (Milestone 2, deliverable B). Mocks the Airtable/federation
// fetches so the assembler → gate → advance-decision chain runs without
// secrets, and proves it is FAIL-CLOSED (a fetch failure → BLOCKED, never a
// pass).

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/airtable", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/airtable")>()),
  getListings: vi.fn(async () => []),
}));
vi.mock("@/lib/federation/property-intel-store", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/federation/property-intel-store")>()),
  findPropertyIntelRecordByListing: vi.fn(async () => null),
}));

import { getListings } from "@/lib/airtable";
import { assemblePreEmdGateInputForDeal } from "./pre-emd-gate-live";
import { evaluatePreEmdGate, emdAdvanceDecision } from "./pre-emd-gate";
import type { Deal } from "@/lib/types";

const NOW = new Date("2026-06-16T12:00:00.000Z");
const deal = (over: Partial<Deal> = {}): Deal =>
  ({ id: "recDealTest1", propertyAddress: "23 Fields Ave, Memphis, TN", contractPrice: 61750, ...over } as Deal);

describe("INV-023 live wiring — a BLOCKED record cannot advance", () => {
  it("a deal with no DD attestations + no joinable listing → BLOCKED → advance refused (423)", async () => {
    const input = await assemblePreEmdGateInputForDeal(deal());
    // fail-closed mapping: attestations false, listing fields null, and in
    // watched mode (ARV engine default-OFF) DD-1's engine input is null.
    expect(input.arvEngine ?? null).toBeNull();
    expect(input.operatorSignoff).toBe(false);
    expect(input.buyerMedian).toBeNull();

    const gate = evaluatePreEmdGate({ ...input, now: NOW });
    expect(gate.verdict).toBe("BLOCKED");

    const decision = emdAdvanceDecision(gate);
    expect(decision.allowed).toBe(false);
    expect(decision.httpStatus).toBe(423);
    expect(decision.blocked_checks.length).toBeGreaterThan(0);
  });

  it("fail-closed: if getListings THROWS, the gate is still BLOCKED (never a pass)", async () => {
    (getListings as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("airtable down"));
    const input = await assemblePreEmdGateInputForDeal(deal({ preEmdOperatorSignoff: true }));
    const gate = evaluatePreEmdGate({ ...input, now: NOW });
    expect(gate.verdict).toBe("BLOCKED");
    expect(emdAdvanceDecision(gate).allowed).toBe(false);
  });
});
