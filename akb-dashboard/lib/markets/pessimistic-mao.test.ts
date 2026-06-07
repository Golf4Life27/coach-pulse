// @agent: orchestrator — pessimistic MAO + rehab-scope tier tests.
import { describe, it, expect } from "vitest";
import { computePessimisticMao, classifyRehabTier } from "./pessimistic-mao";

const DETROIT_ARV_PCT = 0.6461;

describe("computePessimisticMao", () => {
  it("Strathmoor fixture (conservativeArv $161k, rehabHigh $48,664, floor $52k) → fails_floor", () => {
    // 161,000 × 0.6461 − 48,664 − 5,000 = 104,022 − 53,664 = $50,358.
    // Floor $52,000 → margin = $50,358 − $52,000 = −$1,642 → fails_floor.
    const r = computePessimisticMao({
      conservativeArv: 161_000,
      rehabHigh: 48_664,
      arvPctMax: DETROIT_ARV_PCT,
      stickyFloor: 52_000,
    });
    expect(r.pessimisticMao).toBe(50_358);
    expect(r.verdict).toBe("fails_floor");
    expect(r.marginOverFloor).toBe(-1642);
  });

  it("robust verdict requires margin ≥ 10% of the sticky floor", () => {
    // Mao 60k vs floor 50k → margin 10k = 20% → robust.
    const r = computePessimisticMao({ conservativeArv: 110_000, rehabHigh: 5_000, arvPctMax: DETROIT_ARV_PCT, stickyFloor: 50_000 });
    expect(r.verdict).toBe("robust");
  });

  it("marginal verdict: clears floor by less than 10%", () => {
    // 80,000 × 0.6461 − 0 − 5,000 = $46,688; floor $46,000 → margin $688 (1.5%) → marginal.
    const r = computePessimisticMao({ conservativeArv: 80_000, rehabHigh: 0, arvPctMax: DETROIT_ARV_PCT, stickyFloor: 46_000 });
    expect(r.verdict).toBe("marginal");
  });

  it("HOLD when conservativeArv or rehabHigh missing", () => {
    expect(computePessimisticMao({ conservativeArv: null, rehabHigh: 30_000, arvPctMax: DETROIT_ARV_PCT }).verdict).toBe("hold");
    expect(computePessimisticMao({ conservativeArv: 200_000, rehabHigh: null, arvPctMax: DETROIT_ARV_PCT }).verdict).toBe("hold");
  });
});

describe("classifyRehabTier", () => {
  it("AS-IS on Strathmoor #001 fixture: exposed wiring + incomplete bathroom", () => {
    const r = classifyRehabTier({
      visionCondition: "Fair",
      visionConfidence: 62,
      scopeText:
        "Bathroom shows incomplete mid-renovation state: large open cavity in wall exposing lathe/studs with exposed wiring hanging loose, access holes cut in tile.",
    });
    expect(r.tier).toBe("as_is");
    expect(r.hardStops).toContain("exposed wiring");
    expect(r.hardStops).toContain("incomplete bath/kitchen / mid-renovation");
  });

  it("AS-IS on Poor / Disrepair condition", () => {
    expect(classifyRehabTier({ visionCondition: "Poor", scopeText: "" }).tier).toBe("as_is");
    expect(classifyRehabTier({ visionCondition: "Disrepair", scopeText: "" }).tier).toBe("as_is");
  });

  it("LIGHT_RETAIL on Average/Fair without hard-stops", () => {
    expect(classifyRehabTier({ visionCondition: "Average", scopeText: "dated kitchen, paint needed" }).tier).toBe("light_retail");
    expect(classifyRehabTier({ visionCondition: "Fair", scopeText: "dated finishes" }).tier).toBe("light_retail");
  });

  it("LIGHT_RETAIL when confidence < 70 (uncertain → don't price to full retail)", () => {
    expect(classifyRehabTier({ visionCondition: "Good", visionConfidence: 62, scopeText: "" }).tier).toBe("light_retail");
  });

  it("FULL_RETAIL on Good with confidence ≥ 70", () => {
    expect(classifyRehabTier({ visionCondition: "Good", visionConfidence: 80, scopeText: "fresh paint, new floors" }).tier).toBe("full_retail");
  });

  it("knob-and-tube wiring is a hard stop → as_is", () => {
    const r = classifyRehabTier({ visionCondition: "Average", scopeText: "Likely knob-and-tube panel" });
    expect(r.tier).toBe("as_is");
    expect(r.hardStops).toContain("knob-and-tube wiring");
  });
});
