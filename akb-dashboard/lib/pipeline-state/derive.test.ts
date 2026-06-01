// @agent: orchestrator — Pipeline_State legacy-derivation tests.
//
// The dry-run-only mapping from the legacy field tangle. Verifies the
// 23 Fields contradiction case lands at `negotiating` with the
// intake-reject flagged as a `conflicts` entry — so the operator's
// dry-run report surfaces it for review.

import { describe, it, expect } from "vitest";
import { deriveStageFromLegacy } from "./derive";

describe("deriveStageFromLegacy — short-circuits", () => {
  it("returns existing pipelineStage verbatim when already populated", () => {
    const r = deriveStageFromLegacy({
      pipelineStage: "under_contract",
      outreachStatus: "Negotiating",
      executionPath: "Reject",
    });
    expect(r.stage).toBe("under_contract");
    expect(r.reason).toBe("pipeline_stage_already_set");
    expect(r.confidence).toBe("high");
  });

  it("treats whitespace-only pipelineStage as empty", () => {
    const r = deriveStageFromLegacy({
      pipelineStage: "   ",
      outreachStatus: "Texted",
      executionPath: "Auto Proceed",
      liveStatus: "Active",
    });
    expect(r.stage).toBe("outreach_sent");
  });
});

describe("deriveStageFromLegacy — terminal/contract precedence", () => {
  it("Outreach_Status=Dead → dead (highest precedence)", () => {
    const r = deriveStageFromLegacy({
      outreachStatus: "Dead",
      envelopeId: "abc-123",
      contractOfferPrice: 90000,
    });
    expect(r.stage).toBe("dead");
    expect(r.reason).toBe("dead_signal");
  });

  it("Envelope_ID set → under_contract", () => {
    const r = deriveStageFromLegacy({
      envelopeId: "env-789",
      outreachStatus: "Negotiating",
    });
    expect(r.stage).toBe("under_contract");
    expect(r.reason).toBe("envelope_or_contract_signed");
  });

  it("Outreach_Status=Contract Signed → under_contract", () => {
    const r = deriveStageFromLegacy({
      outreachStatus: "Contract Signed",
    });
    expect(r.stage).toBe("under_contract");
  });

  it("contractOfferPrice set (no envelope) → offer_drafted", () => {
    const r = deriveStageFromLegacy({
      outreachStatus: "Negotiating",
      contractOfferPrice: 91000,
    });
    expect(r.stage).toBe("offer_drafted");
    expect(r.reason).toBe("offer_drafted_signal");
  });
});

describe("deriveStageFromLegacy — outreach-status mapping", () => {
  it("Outreach_Status=Response Received → responded (new locked stage)", () => {
    const r = deriveStageFromLegacy({ outreachStatus: "Response Received" });
    expect(r.stage).toBe("responded");
    expect(r.reason).toBe("responded_signal");
  });

  it("Outreach_Status ∈ {Negotiating, Counter Received} → negotiating", () => {
    expect(deriveStageFromLegacy({ outreachStatus: "Negotiating" }).stage).toBe("negotiating");
    expect(deriveStageFromLegacy({ outreachStatus: "Counter Received" }).stage).toBe("negotiating");
  });

  it("Outreach_Status ∈ {Texted, Emailed, Texted (Portfolio)} → outreach_sent", () => {
    expect(deriveStageFromLegacy({ outreachStatus: "Texted" }).stage).toBe("outreach_sent");
    expect(deriveStageFromLegacy({ outreachStatus: "Emailed" }).stage).toBe("outreach_sent");
    expect(deriveStageFromLegacy({ outreachStatus: "Texted (Portfolio)" }).stage).toBe("outreach_sent");
  });

  it("Outreach_Status ∈ {Review, Manual Review} → verified (held)", () => {
    expect(deriveStageFromLegacy({ outreachStatus: "Review" }).stage).toBe("verified");
    expect(deriveStageFromLegacy({ outreachStatus: "Manual Review" }).stage).toBe("verified");
  });
});

describe("deriveStageFromLegacy — intake-reject + default", () => {
  it("Execution_Path=Reject (no progressed outreach) → dead", () => {
    const r = deriveStageFromLegacy({
      executionPath: "Reject",
      outreachStatus: "",
    });
    expect(r.stage).toBe("dead");
    expect(r.reason).toBe("intake_rejected");
  });

  it("empty Outreach_Status + Auto Proceed + Active → outreach_ready", () => {
    const r = deriveStageFromLegacy({
      outreachStatus: "",
      executionPath: "Auto Proceed",
      liveStatus: "Active",
    });
    expect(r.stage).toBe("outreach_ready");
    expect(r.reason).toBe("outreach_ready_signal");
  });

  it("no decisive signal → intake (default)", () => {
    const r = deriveStageFromLegacy({});
    expect(r.stage).toBe("intake");
    expect(r.reason).toBe("intake_default");
    expect(r.confidence).toBe("low");
  });
});

describe("deriveStageFromLegacy — 23 Fields Ave contradiction class (the smoking gun)", () => {
  it("Outreach_Status=Negotiating + Execution_Path=Reject → negotiating WITH conflict flag", () => {
    // The exact 23 Fields shape: in-progress outreach + intake-reject + no envelope.
    const r = deriveStageFromLegacy({
      outreachStatus: "Negotiating",
      executionPath: "Reject",
      liveStatus: "Active",
    });
    expect(r.stage).toBe("negotiating");
    expect(r.confidence).toBe("low");
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]).toContain("Reject");
    expect(r.conflicts[0]).toContain("Negotiating");
  });

  it("Outreach_Status=Offer Accepted + Execution_Path=Reject → offer_drafted WITH conflict", () => {
    const r = deriveStageFromLegacy({
      outreachStatus: "Offer Accepted",
      executionPath: "Reject",
    });
    expect(r.stage).toBe("offer_drafted");
    expect(r.conflicts.length).toBe(1);
  });

  it("Outreach_Status=Response Received + Execution_Path=Reject → responded WITH conflict", () => {
    const r = deriveStageFromLegacy({
      outreachStatus: "Response Received",
      executionPath: "Reject",
    });
    expect(r.stage).toBe("responded");
    expect(r.conflicts.length).toBe(1);
  });
});
