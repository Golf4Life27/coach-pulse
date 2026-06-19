// PROOF (M7 Part 1, operator 2026-06-18): a synthetic Detroit lead
// traverses the wired front-half end-to-end — verified → priced →
// outreach_ready → Gate 1 → operator surface — with ALL external I/O mocked.
// This is the prove-don't-claim deliverable for closing the priced=0 break:
// before this build the belt was severed at verified→priced→outreach_ready
// (Gate 1 declared the illegal verified→outreach_ready skip the engine
// refused). The test exercises the REAL sole-writer engine legal edges, the
// REAL Gate 1 check functions, and the REAL operator hand-off — no stubs of
// the logic under test, only the Airtable/audit I/O deps.

import { describe, it, expect, vi } from "vitest";
import { transitionToPriced } from "./price-transition";
import { transitionStage, type TransitionDeps } from "./engine";
import {
  PRE_OUTREACH_GATE,
  PRE_OUTREACH_CHECKS,
  PRE_OUTREACH_CONFIG,
} from "@/lib/orchestrator/pre-outreach-checks";
import { preContractOperatorHandoff } from "@/lib/orchestrator/pre-contract-handoff";
import type { GateContext, GateRunResult } from "@/lib/orchestrator/types";
import type { Listing } from "@/lib/types";

// A synthetic Detroit lead engineered to PASS every blocking Pre-Outreach
// item (PO-01..PO-14). Only the fields the checks read are set; cast through
// unknown so the test isn't coupled to the full Listing surface.
function detroitLead(): Listing {
  return {
    id: "rec00000DETROIT01",
    address: "1 Synthetic Test Way",
    city: "Detroit",
    state: "MI",
    zip: "48227",
    mlsStatus: "Active",
    liveStatus: "Active",
    // verified ~1h ago → well within the 72h freshness window (PO-02).
    lastVerified: new Date(Date.now() - 60 * 60_000).toISOString(),
    offMarketOverride: false,
    propertyType: "Single Family Residence",
    bedrooms: 3,
    buildingSqFt: 1200,
    listPrice: 50_000,
    agentPhone: "313-555-0142", // 10 digits, area code 313 (not toll-free)
    flipScore: 1,
    dom: 90, // distress present (>= 60) — PO-13
    priceDropCount: 1,
    doNotText: false,
    pipelineStage: "verified",
  } as unknown as Listing;
}

function mkDeps() {
  const updateListing = vi.fn(async () => []);
  const audit = vi.fn(async () => {});
  const deps: TransitionDeps = {
    updateListing,
    audit: audit as unknown as TransitionDeps["audit"],
    getCurrentStage: vi.fn(async () => null),
    now: () => new Date("2026-06-18T00:00:00.000Z"),
  };
  return { deps, updateListing };
}

function runGate1(listing: Listing) {
  const ctx: GateContext = {
    recordId: listing.id,
    listing,
    auditLog: null,
    quoThread: null,
    gmailThread: null,
    liveListing: null,
    cma: null,
    paDocument: null,
    buyerPipeline: null,
    propertyIntel: null,
    deal: null,
  };
  const results = PRE_OUTREACH_GATE.items.map((it) =>
    PRE_OUTREACH_CHECKS[it.id](ctx, PRE_OUTREACH_CONFIG),
  );
  return {
    results,
    blockers: results.filter((r) => r.status === "fail").map((r) => r.item_id),
    dataMissing: results.filter((r) => r.status === "data_missing").map((r) => r.item_id),
  };
}

describe("M7 front-half flow — synthetic Detroit lead", () => {
  it("traverses verified → priced → outreach_ready → Gate 1 → operator surface", async () => {
    const lead = detroitLead();
    const { deps, updateListing } = mkDeps();

    // ── Hop A: verified → priced (the previously-missing writer) ────────
    const toPriced = await transitionToPriced(lead.id, "verified", "opener_written", deps);
    expect(toPriced.ok).toBe(true);
    expect(toPriced.outcome).toBe("applied");
    expect(toPriced.legality.reason).toBe("ok_forward_one_step");
    expect(updateListing).toHaveBeenCalledWith(lead.id, { Pipeline_Stage: "priced" });

    // ── Gate 1: priced → outreach_ready, checks must PASS for this lead ──
    const gate1 = runGate1(lead);
    expect(gate1.blockers).toEqual([]);
    expect(gate1.dataMissing).toEqual([]);

    // ── Hop B: priced → outreach_ready (now a LEGAL one-step edge) ──────
    const toReady = await transitionStage(
      {
        recordId: lead.id,
        to: "outreach_ready",
        reason: "gate_passed:pre_outreach",
        attribution: "sentry",
        triggered_by: "orchestrator",
        current: { pipelineStage: "priced" },
      },
      deps,
    );
    expect(toReady.ok).toBe(true);
    expect(toReady.outcome).toBe("applied");
    expect(toReady.legality.reason).toBe("ok_forward_one_step");

    // ── Terminus: at the contract wall, surface CLEANLY to the operator ─
    // (DocuSign unwired → pre_contract data_missing, never a crash.)
    const preContract: GateRunResult = {
      gate_id: "pre_contract",
      recordId: lead.id,
      stage_from: "negotiating",
      stage_to: "under_contract",
      current_stage: "negotiating",
      overall_status: "fail",
      results: [],
      blockers: [],
      data_missing: ["PC-01", "PC-08"],
      warnings: [],
      computed_at: "2026-06-18T00:00:00.000Z",
      elapsed_ms: 1,
    };
    const handoff = preContractOperatorHandoff(preContract);
    expect(handoff.surfaceToOperator).toBe(true);
    expect(handoff.outreachStatus).toBe("Manual Review");
    expect(handoff.reason).toBe("awaiting_operator_signature");
  });

  it("REGRESSION GUARD: the old verified → outreach_ready skip stays illegal", async () => {
    // The bug was Gate 1 declaring this edge; the sole-writer engine must
    // keep refusing it so the conveyor can only flow THROUGH priced.
    const { deps, updateListing } = mkDeps();
    const skip = await transitionStage(
      {
        recordId: "rec00000DETROIT01",
        to: "outreach_ready",
        reason: "illegal_skip_attempt",
        attribution: "test",
        triggered_by: "orchestrator",
        current: { pipelineStage: "verified" },
      },
      deps,
    );
    expect(skip.ok).toBe(false);
    expect(skip.outcome).toBe("rejected_illegal");
    expect(skip.legality.reason).toBe("illegal_skip_forward");
    expect(updateListing).not.toHaveBeenCalled();
  });

  it("Gate 1 now declares the priced → outreach_ready edge", () => {
    expect(PRE_OUTREACH_GATE.stage_from).toBe("priced");
    expect(PRE_OUTREACH_GATE.stage_to).toBe("outreach_ready");
  });
});
