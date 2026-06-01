// @agent: orchestrator — Pipeline_State canonical-stage tests.
import { describe, it, expect } from "vitest";
import {
  ALL_PIPELINE_STAGES,
  STAGE_ORDER,
  TERMINAL_STAGES,
  LIVE_STAGES,
  isPipelineStage,
  type PipelineStage,
} from "./stages";

describe("ALL_PIPELINE_STAGES", () => {
  it("has exactly the 13 locked stages in lifecycle order", () => {
    expect(ALL_PIPELINE_STAGES).toEqual([
      "intake",
      "verified",
      "priced",
      "outreach_ready",
      "outreach_sent",
      "responded",
      "negotiating",
      "offer_drafted",
      "under_contract",
      "dispo_active",
      "assignment_signed",
      "closed",
      "dead",
    ]);
  });

  it("includes the new `responded` stage (locked decision #2)", () => {
    expect(ALL_PIPELINE_STAGES.includes("responded" as PipelineStage)).toBe(true);
    expect(ALL_PIPELINE_STAGES.indexOf("responded")).toBe(
      ALL_PIPELINE_STAGES.indexOf("outreach_sent") + 1,
    );
    expect(ALL_PIPELINE_STAGES.indexOf("negotiating")).toBe(
      ALL_PIPELINE_STAGES.indexOf("responded") + 1,
    );
  });
});

describe("STAGE_ORDER", () => {
  it("orders forward stages by lifecycle position with `dead` as terminal sink", () => {
    expect(STAGE_ORDER["intake"]).toBeLessThan(STAGE_ORDER["under_contract"]);
    expect(STAGE_ORDER["under_contract"]).toBeLessThan(STAGE_ORDER["closed"]);
    // Spec §5 isUnderContract — `under_contract` and beyond must compare >= the gate.
    expect(STAGE_ORDER["under_contract"]).toBeGreaterThanOrEqual(STAGE_ORDER["under_contract"]);
    expect(STAGE_ORDER["dispo_active"]).toBeGreaterThan(STAGE_ORDER["under_contract"]);
    expect(STAGE_ORDER["assignment_signed"]).toBeGreaterThan(STAGE_ORDER["under_contract"]);
    expect(STAGE_ORDER["closed"]).toBeGreaterThan(STAGE_ORDER["under_contract"]);
  });
  it("sinks `dead` beyond every forward stage", () => {
    for (const s of LIVE_STAGES) {
      expect(STAGE_ORDER["dead"]).toBeGreaterThan(STAGE_ORDER[s]);
    }
  });
});

describe("TERMINAL_STAGES / LIVE_STAGES", () => {
  it("treats `closed` and `dead` as terminal; everything else live", () => {
    expect(TERMINAL_STAGES.has("closed")).toBe(true);
    expect(TERMINAL_STAGES.has("dead")).toBe(true);
    for (const s of LIVE_STAGES) {
      expect(TERMINAL_STAGES.has(s)).toBe(false);
    }
  });
});

describe("isPipelineStage", () => {
  it("accepts valid stage strings, rejects everything else", () => {
    expect(isPipelineStage("under_contract")).toBe(true);
    expect(isPipelineStage("responded")).toBe(true);
    expect(isPipelineStage("Under Contract")).toBe(false); // case + space
    expect(isPipelineStage("foo")).toBe(false);
    expect(isPipelineStage("")).toBe(false);
    expect(isPipelineStage(null)).toBe(false);
    expect(isPipelineStage(undefined)).toBe(false);
    expect(isPipelineStage(7)).toBe(false);
  });
});
