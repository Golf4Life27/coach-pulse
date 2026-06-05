// @agent: pulse — Verification_URL coverage detector tests.
import { describe, it, expect } from "vitest";
import { detectVerificationUrlCoverage } from "./verification-url-coverage";
import type { PulseDetectorInput } from "../detector-input";

function makeInput(
  coverage: PulseDetectorInput["verification_url_coverage"],
  env: Record<string, string | undefined> = {},
): PulseDetectorInput {
  return {
    audit_log: [],
    listings: [],
    test_count: null,
    previous_test_count: null,
    env,
    verification_url_coverage: coverage,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
  };
}

describe("detectVerificationUrlCoverage", () => {
  it("does not fire above the warning floor (healthy coverage)", () => {
    // 1751/2147 = 81.6% — above the 80% default warning floor.
    const out = detectVerificationUrlCoverage(
      makeInput({ activeTotal: 2147, withUrl: 1751, withoutUrl: 396, coveragePct: 81.6 }),
    );
    expect(out).toEqual([]);
  });

  it("fires WARNING between critical and warning floors", () => {
    const out = detectVerificationUrlCoverage(
      makeInput({ activeTotal: 1000, withUrl: 700, withoutUrl: 300, coveragePct: 70 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warning");
    expect(out[0].detector_id).toBe("verification_url_coverage");
    expect(out[0].source_data?.coverage_pct).toBe(70);
  });

  it("fires CRITICAL below the critical floor", () => {
    const out = detectVerificationUrlCoverage(
      makeInput({ activeTotal: 1000, withUrl: 500, withoutUrl: 500, coveragePct: 50 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("critical");
  });

  it("no-ops on null coverage (query failed/skipped)", () => {
    expect(detectVerificationUrlCoverage(makeInput(null))).toEqual([]);
    expect(detectVerificationUrlCoverage(makeInput(undefined))).toEqual([]);
  });

  it("no-ops on zero active records (no data, not a coverage problem)", () => {
    expect(
      detectVerificationUrlCoverage(
        makeInput({ activeTotal: 0, withUrl: 0, withoutUrl: 0, coveragePct: 0 }),
      ),
    ).toEqual([]);
  });

  it("honors operator threshold overrides", () => {
    // Raise the warning floor to 90 → 85% now fires warning.
    const out = detectVerificationUrlCoverage(
      makeInput(
        { activeTotal: 100, withUrl: 85, withoutUrl: 15, coveragePct: 85 },
        { PULSE_URL_COVERAGE_WARNING_PCT: "90", PULSE_URL_COVERAGE_CRITICAL_PCT: "70" },
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warning");
  });
});
