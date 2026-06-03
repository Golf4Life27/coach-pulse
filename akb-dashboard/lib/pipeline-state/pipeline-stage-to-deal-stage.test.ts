// @agent: maverick / orchestrator
// Pipeline_Stage → DealStage mapping tests (Track B re-point).
import { describe, it, expect } from "vitest";
import { pipelineStageToDealStage } from "./pipeline-stage-to-deal-stage";
import { ALL_PIPELINE_STAGES } from "./stages";

describe("pipelineStageToDealStage", () => {
  it("returns null for empty / null / undefined / whitespace input", () => {
    expect(pipelineStageToDealStage(null)).toBeNull();
    expect(pipelineStageToDealStage(undefined)).toBeNull();
    expect(pipelineStageToDealStage("")).toBeNull();
    expect(pipelineStageToDealStage("   ")).toBeNull();
  });

  it("returns null for unrecognized stage strings", () => {
    expect(pipelineStageToDealStage("foo")).toBeNull();
    expect(pipelineStageToDealStage("Under Contract")).toBeNull(); // wrong case + space
  });

  it("maps every PipelineStage value to a non-null DealStage (exhaustiveness)", () => {
    for (const s of ALL_PIPELINE_STAGES) {
      expect(pipelineStageToDealStage(s)).not.toBeNull();
    }
  });

  it("collapses pre-outreach stages onto `cold`", () => {
    expect(pipelineStageToDealStage("intake")).toBe("cold");
    expect(pipelineStageToDealStage("verified")).toBe("cold");
    expect(pipelineStageToDealStage("priced")).toBe("cold");
    expect(pipelineStageToDealStage("outreach_ready")).toBe("cold");
  });

  it("maps outreach_sent → outreach + responded → engaged", () => {
    expect(pipelineStageToDealStage("outreach_sent")).toBe("outreach");
    expect(pipelineStageToDealStage("responded")).toBe("engaged");
  });

  it("maps negotiating + offer_drafted + under_contract correctly", () => {
    expect(pipelineStageToDealStage("negotiating")).toBe("negotiating");
    expect(pipelineStageToDealStage("offer_drafted")).toBe("accepted_pending_pa");
    expect(pipelineStageToDealStage("under_contract")).toBe("pa_signed");
  });

  it("collapses dispo + assignment_signed onto closing; closed → won", () => {
    expect(pipelineStageToDealStage("dispo_active")).toBe("closing");
    expect(pipelineStageToDealStage("assignment_signed")).toBe("closing");
    expect(pipelineStageToDealStage("closed")).toBe("won");
  });

  it("maps dead → dead (terminal failure)", () => {
    expect(pipelineStageToDealStage("dead")).toBe("dead");
  });

  it("trims whitespace from valid inputs", () => {
    expect(pipelineStageToDealStage("  negotiating  ")).toBe("negotiating");
  });
});
