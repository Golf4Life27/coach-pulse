// @agent: maverick — Pipeline_State dry-run backfill report tests.
import { describe, it, expect } from "vitest";
import { buildBackfillReport, type BackfillReportListing } from "./backfill-report";

function L(over: Partial<BackfillReportListing> & { id: string }): BackfillReportListing {
  return { ...over } as BackfillReportListing;
}

describe("buildBackfillReport — aggregation", () => {
  it("counts already-populated vs proposed-change correctly", () => {
    const r = buildBackfillReport([
      L({ id: "rec1", pipelineStage: "negotiating" }),                                          // already populated
      L({ id: "rec2", outreachStatus: "Texted", executionPath: "Auto Proceed", liveStatus: "Active" }), // -> outreach_sent
      L({ id: "rec3", outreachStatus: "Dead" }),                                                // -> dead
    ]);
    expect(r.total_records).toBe(3);
    expect(r.records_already_populated).toBe(1);
    expect(r.records_with_proposed_change).toBe(2);
  });

  it("produces a histogram across the proposed stages including unused ones at zero", () => {
    const r = buildBackfillReport([
      L({ id: "a", outreachStatus: "Negotiating" }),
      L({ id: "b", outreachStatus: "Negotiating" }),
      L({ id: "c", outreachStatus: "Response Received" }),
    ]);
    expect(r.histogram_proposed.negotiating).toBe(2);
    expect(r.histogram_proposed.responded).toBe(1);
    expect(r.histogram_proposed.intake).toBe(0);
    expect(r.histogram_proposed.closed).toBe(0);
  });

  it("counts reason codes", () => {
    const r = buildBackfillReport([
      L({ id: "a", outreachStatus: "Negotiating" }),
      L({ id: "b", outreachStatus: "Negotiating" }),
      L({ id: "c", outreachStatus: "Texted" }),
    ]);
    expect(r.histogram_reason.negotiating_signal).toBe(2);
    expect(r.histogram_reason.outreach_sent_signal).toBe(1);
  });

  it("breaks down confidence high/medium/low", () => {
    const r = buildBackfillReport([
      // high
      L({ id: "a", envelopeId: "x", outreachStatus: "Contract Signed" }),
      // medium
      L({ id: "b", outreachStatus: "Texted" }),
      // low (default)
      L({ id: "c" }),
    ]);
    expect(r.confidence_breakdown.high).toBe(1);
    expect(r.confidence_breakdown.medium).toBe(1);
    expect(r.confidence_breakdown.low).toBe(1);
  });
});

describe("buildBackfillReport — conflict surfacing (23-Fields-class)", () => {
  it("counts records_with_conflicts and surfaces them in conflicts_sample", () => {
    const r = buildBackfillReport([
      // The exact 23 Fields shape
      L({
        id: "rec1HTUqK0YEVb7uA",
        address: "23 Fields Ave",
        outreachStatus: "Negotiating",
        executionPath: "Reject",
        liveStatus: "Active",
      }),
      // Clean record
      L({ id: "clean", outreachStatus: "Texted" }),
    ]);
    expect(r.records_with_conflicts).toBe(1);
    expect(r.conflicts_sample).toHaveLength(1);
    expect(r.conflicts_sample[0].recordId).toBe("rec1HTUqK0YEVb7uA");
    expect(r.conflicts_sample[0].proposed).toBe("negotiating");
    expect(r.conflicts_sample[0].confidence).toBe("low");
    expect(r.conflicts_sample[0].conflicts.length).toBe(1);
  });

  it("a populated record's existing stage IS surfaced as `current` (no spurious 'changes')", () => {
    const r = buildBackfillReport([
      L({ id: "rec1", pipelineStage: "under_contract" }),
    ]);
    // Populated record is NOT in proposed-transitions-sample.
    expect(r.proposed_transitions_sample).toHaveLength(0);
    expect(r.records_with_proposed_change).toBe(0);
  });
});

describe("buildBackfillReport — sample caps", () => {
  it("caps proposed_transitions_sample and conflicts_sample at sampleLimit", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      L({
        id: `rec${String(i).padStart(3, "0")}A1234567890`,
        outreachStatus: "Negotiating",
        executionPath: "Reject", // forces a conflict on all 200
      }),
    );
    const r = buildBackfillReport(many, { sampleLimit: 25 });
    expect(r.total_records).toBe(200);
    expect(r.records_with_conflicts).toBe(200);
    expect(r.proposed_transitions_sample).toHaveLength(25);
    expect(r.conflicts_sample).toHaveLength(25);
    // Histograms are NOT sample-capped.
    expect(r.histogram_proposed.negotiating).toBe(200);
  });

  it("uses default sampleLimit=50 when not provided", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      L({ id: `rec${i}AAAAAAAAAAAAA`, outreachStatus: "Texted" }),
    );
    const r = buildBackfillReport(many);
    expect(r.proposed_transitions_sample).toHaveLength(50);
  });
});

describe("buildBackfillReport — empty input", () => {
  it("returns a zero report for an empty listing array", () => {
    const r = buildBackfillReport([]);
    expect(r.total_records).toBe(0);
    expect(r.records_already_populated).toBe(0);
    expect(r.records_with_proposed_change).toBe(0);
    expect(r.records_with_conflicts).toBe(0);
    expect(r.proposed_transitions_sample).toHaveLength(0);
    expect(r.conflicts_sample).toHaveLength(0);
    // Every histogram bucket exists at 0.
    expect(Object.values(r.histogram_proposed).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("buildBackfillReport — determinism", () => {
  it("uses injected `now()` so the report is timestamp-stable in tests", () => {
    const r = buildBackfillReport(
      [L({ id: "rec1", outreachStatus: "Texted" })],
      { now: () => new Date("2026-05-31T20:00:00.000Z") },
    );
    expect(r.computed_at).toBe("2026-05-31T20:00:00.000Z");
  });
});
