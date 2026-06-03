// @agent: maverick
// inferDealStage tests — Track B re-point (Spine recUS0oHqXLtEM3lG):
// Pipeline_Stage is the primary signal; outreachStatus is the
// transitional fallback for pre-backfill records.
import { describe, it, expect } from "vitest";
import { inferDealStage, type InferStageInput } from "./deal-stage";

function base(over: Partial<InferStageInput> = {}): InferStageInput {
  return {
    pipelineStage: null,
    outreachStatus: null,
    timeline: [],
    signals: { paDrafting: false, costClarificationPending: false, inspectionStarted: false },
    ...over,
  };
}

describe("inferDealStage — Pipeline_Stage as primary source of truth (Track B)", () => {
  it("maps `negotiating` Pipeline_Stage → negotiating DealStage (no outreachStatus needed)", () => {
    expect(inferDealStage(base({ pipelineStage: "negotiating" }))).toBe("negotiating");
  });

  it("trusts Pipeline_Stage over a contradicting outreachStatus", () => {
    // Pre-backfill class: stage=negotiating but legacy outreachStatus=Dead
    // (the engine corrected it; the field write may have lagged).
    expect(
      inferDealStage(base({ pipelineStage: "negotiating", outreachStatus: "Dead" })),
    ).toBe("negotiating");
  });

  it("dead Pipeline_Stage → dead, regardless of outreachStatus", () => {
    expect(
      inferDealStage(base({ pipelineStage: "dead", outreachStatus: "Negotiating" })),
    ).toBe("dead");
  });

  it("maps every primary stage to the expected DealStage", () => {
    expect(inferDealStage(base({ pipelineStage: "intake" }))).toBe("cold");
    expect(inferDealStage(base({ pipelineStage: "outreach_sent" }))).toBe("outreach");
    expect(inferDealStage(base({ pipelineStage: "responded" }))).toBe("engaged");
    expect(inferDealStage(base({ pipelineStage: "offer_drafted" }))).toBe("accepted_pending_pa");
    expect(inferDealStage(base({ pipelineStage: "under_contract" }))).toBe("pa_signed");
    expect(inferDealStage(base({ pipelineStage: "closed" }))).toBe("won");
  });
});

describe("inferDealStage — overlays still fire on top of Pipeline_Stage", () => {
  it("inspectionStarted overlay escalates a live stage to `inspection`", () => {
    expect(
      inferDealStage(
        base({
          pipelineStage: "under_contract",
          signals: { paDrafting: false, costClarificationPending: false, inspectionStarted: true },
        }),
      ),
    ).toBe("inspection");
  });

  it("inspectionStarted does NOT override terminal stages (dead / won)", () => {
    expect(
      inferDealStage(
        base({
          pipelineStage: "dead",
          signals: { paDrafting: false, costClarificationPending: false, inspectionStarted: true },
        }),
      ),
    ).toBe("dead");
    expect(
      inferDealStage(
        base({
          pipelineStage: "closed",
          signals: { paDrafting: false, costClarificationPending: false, inspectionStarted: true },
        }),
      ),
    ).toBe("won");
  });

  it("accept-pattern in last inbound escalates negotiating → accepted_pending_pa", () => {
    const r = inferDealStage(
      base({
        pipelineStage: "negotiating",
        timeline: [
          { direction: "in", channel: "sms", body: "deal! send the PA" } as never,
        ],
      }),
    );
    expect(r).toBe("accepted_pending_pa");
  });
});

describe("inferDealStage — outreachStatus fallback for pre-backfill records", () => {
  it("with no Pipeline_Stage, falls back to outreachStatus-derived logic", () => {
    expect(inferDealStage(base({ outreachStatus: "Negotiating" }))).toBe("negotiating");
    expect(inferDealStage(base({ outreachStatus: "Texted" }))).toBe("outreach");
    expect(inferDealStage(base({ outreachStatus: "Response Received" }))).toBe("engaged");
    expect(inferDealStage(base({ outreachStatus: "Offer Accepted" }))).toBe("accepted_pending_pa");
    expect(inferDealStage(base({ outreachStatus: "Dead" }))).toBe("dead");
  });

  it("with empty/whitespace Pipeline_Stage, still falls back to outreachStatus", () => {
    expect(inferDealStage(base({ pipelineStage: "   ", outreachStatus: "Negotiating" }))).toBe("negotiating");
  });

  it("with unrecognized Pipeline_Stage value, falls back to outreachStatus", () => {
    expect(inferDealStage(base({ pipelineStage: "garbage", outreachStatus: "Texted" }))).toBe("outreach");
  });
});
