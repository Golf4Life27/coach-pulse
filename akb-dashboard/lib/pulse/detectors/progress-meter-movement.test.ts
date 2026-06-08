import { describe, it, expect } from "vitest";
import { detectProgressMeterMovement } from "./progress-meter-movement";
import type { PulseDetectorInput, ProgressMeterSnapshot } from "../detector-input";

const NOW = new Date("2026-06-08T12:00:00Z");
const baseInput: PulseDetectorInput = {
  audit_log: [],
  listings: [],
  test_count: null,
  previous_test_count: null,
  env: {},
  now: () => NOW,
};

function meter(over: Partial<ProgressMeterSnapshot>): ProgressMeterSnapshot {
  return {
    stall_count: 7,
    high_risk_stalls: 4,
    monthly_net_usd: 0,
    build_pct: 61,
    as_of: NOW.toISOString(),
    ...over,
  };
}

describe("detectProgressMeterMovement — silent baselines", () => {
  it("silent when meter is missing", () => {
    expect(detectProgressMeterMovement(baseInput)).toEqual([]);
  });

  it("silent on first scan (no previous anchor)", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({}),
      previous_progress_meter: null,
    });
    expect(r).toEqual([]);
  });

  it("silent when nothing material moved", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({ build_pct: 62 }), // 1pt is below 5pt material delta
      previous_progress_meter: meter({ build_pct: 61 }),
    });
    expect(r).toEqual([]);
  });
});

describe("detectProgressMeterMovement — stall count", () => {
  it("fires WARNING on a HIGH-risk stall regression", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({ stall_count: 8, high_risk_stalls: 5 }),
      previous_progress_meter: meter({ stall_count: 7, high_risk_stalls: 4 }),
    });
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("warning");
    expect(r[0].id).toBe("progress_meter_stall_regression");
  });

  it("fires INFO on a non-HIGH stall regression", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({ stall_count: 8, high_risk_stalls: 4 }),
      previous_progress_meter: meter({ stall_count: 7, high_risk_stalls: 4 }),
    });
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("info");
  });

  it("fires INFO when a stall clears (forward motion on the load-bearing metric)", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({ stall_count: 6, high_risk_stalls: 3 }),
      previous_progress_meter: meter({ stall_count: 7, high_risk_stalls: 4 }),
    });
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("info");
    expect(r[0].id).toBe("progress_meter_stall_improved");
  });
});

describe("detectProgressMeterMovement — deal velocity (the headline)", () => {
  it("fires CRITICAL when velocity crosses $0 upward (first deal!)", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({ monthly_net_usd: 15_000 }),
      previous_progress_meter: meter({ monthly_net_usd: 0 }),
    });
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("critical");
    expect(r[0].id).toBe("progress_meter_velocity_unblocked");
    expect(r[0].title).toContain("$15,000");
  });

  it("fires WARNING when velocity drops > 20% MoM", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({ monthly_net_usd: 10_000 }),
      previous_progress_meter: meter({ monthly_net_usd: 20_000 }),
    });
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("warning");
    expect(r[0].id).toBe("progress_meter_velocity_drop");
  });

  it("respects PULSE_PROGRESS_VELOCITY_DROP_PCT override", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      env: { PULSE_PROGRESS_VELOCITY_DROP_PCT: "50" },
      progress_meter: meter({ monthly_net_usd: 12_000 }),
      previous_progress_meter: meter({ monthly_net_usd: 20_000 }), // 40% drop
    });
    expect(r).toEqual([]); // below the 50% override
  });

  it("does NOT fire when velocity stays at $0 (the current real state)", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({ monthly_net_usd: 0 }),
      previous_progress_meter: meter({ monthly_net_usd: 0 }),
    });
    expect(r).toEqual([]);
  });
});

describe("detectProgressMeterMovement — build%", () => {
  it("fires WARNING on any build% regression", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({ build_pct: 60 }),
      previous_progress_meter: meter({ build_pct: 61 }),
    });
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("warning");
    expect(r[0].id).toBe("progress_meter_build_regression");
  });

  it("fires INFO on a ≥5pt material build gain", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({ build_pct: 67 }),
      previous_progress_meter: meter({ build_pct: 61 }),
    });
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("info");
    expect(r[0].id).toBe("progress_meter_build_material_gain");
  });

  it("respects PULSE_PROGRESS_BUILD_PCT_MATERIAL override", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      env: { PULSE_PROGRESS_BUILD_PCT_MATERIAL: "10" },
      progress_meter: meter({ build_pct: 67 }),
      previous_progress_meter: meter({ build_pct: 61 }),
    });
    expect(r).toEqual([]); // 6pt below the 10pt override
  });
});

describe("detectProgressMeterMovement — composition", () => {
  it("can fire multiple detections per scan when several metrics move", () => {
    const r = detectProgressMeterMovement({
      ...baseInput,
      progress_meter: meter({ stall_count: 6, high_risk_stalls: 3, monthly_net_usd: 12_000, build_pct: 68 }),
      previous_progress_meter: meter({ stall_count: 7, high_risk_stalls: 4, monthly_net_usd: 0, build_pct: 61 }),
    });
    // stall improved + velocity unblocked + build material gain
    expect(r).toHaveLength(3);
    const ids = r.map((d) => d.id).sort();
    expect(ids).toEqual([
      "progress_meter_build_material_gain",
      "progress_meter_stall_improved",
      "progress_meter_velocity_unblocked",
    ]);
  });
});
