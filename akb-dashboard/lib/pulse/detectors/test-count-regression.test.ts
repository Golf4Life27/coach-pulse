// Phase 14 / O.4 — test-count-regression detector tests.

import { describe, it, expect } from "vitest";
import { detectTestCountRegression } from "./test-count-regression";

const NOW = new Date("2026-05-18T20:00:00Z");

const baseInput = {
  audit_log: [],
  listings: [],
  test_count: 750,
  previous_test_count: 750,
  env: {},
  now: () => NOW,
};

describe("detectTestCountRegression", () => {
  it("doesn't fire when count is unchanged", () => {
    expect(detectTestCountRegression(baseInput)).toEqual([]);
  });

  it("doesn't fire when count increases", () => {
    expect(
      detectTestCountRegression({ ...baseInput, test_count: 760 }),
    ).toEqual([]);
  });

  it("doesn't fire when drop is below warning threshold (default 3)", () => {
    expect(
      detectTestCountRegression({
        ...baseInput,
        test_count: 748,
        previous_test_count: 750,
      }),
    ).toEqual([]); // drop 2 < warning 3
  });

  it("fires warning at drop ≥ 3", () => {
    const dets = detectTestCountRegression({
      ...baseInput,
      test_count: 745,
      previous_test_count: 750,
    });
    expect(dets[0].severity).toBe("warning");
    expect(dets[0].detector_id).toBe("test_count_regression");
  });

  it("fires critical at drop ≥ 10 (likely whole-file deletion)", () => {
    const dets = detectTestCountRegression({
      ...baseInput,
      test_count: 720,
      previous_test_count: 750,
    });
    expect(dets[0].severity).toBe("critical");
  });

  it("returns [] silently when test_count is null (dev mode, prebuild missing)", () => {
    expect(
      detectTestCountRegression({
        ...baseInput,
        test_count: null,
        previous_test_count: 750,
      }),
    ).toEqual([]);
  });

  it("returns [] silently when previous_test_count is null (first-scan baseline)", () => {
    expect(
      detectTestCountRegression({
        ...baseInput,
        test_count: 750,
        previous_test_count: null,
      }),
    ).toEqual([]);
  });

  it("respects env-overridable thresholds", () => {
    const dets = detectTestCountRegression({
      ...baseInput,
      test_count: 748,
      previous_test_count: 750,
      env: { PULSE_TEST_DROP_WARNING: "1" },
    });
    expect(dets[0].severity).toBe("warning"); // drop 2 ≥ warning 1
  });
});
