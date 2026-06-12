import { describe, it, expect } from "vitest";
import { computeSanityRail } from "./sanity-rail";

describe("computeSanityRail", () => {
  it("within 25% → not flagged", () => {
    const r = computeSanityRail(50_000, 55_000); // ~9.1%
    expect(r.flagged).toBe(false);
    expect(r.deltaPct).toBeCloseTo(0.0909, 3);
  });
  it("exactly at 25% → flagged (inclusive)", () => {
    const r = computeSanityRail(75_000, 60_000); // 25%
    expect(r.flagged).toBe(true);
  });
  it("large divergence → flagged with review prose", () => {
    const r = computeSanityRail(120_000, 55_000);
    expect(r.flagged).toBe(true);
    expect(r.description).toContain("never gates");
  });
  it("missing either input → null rail, never fabricated", () => {
    expect(computeSanityRail(null, 55_000).deltaPct).toBeNull();
    expect(computeSanityRail(50_000, null).deltaPct).toBeNull();
    expect(computeSanityRail(0, 55_000).deltaPct).toBeNull();
  });
});
