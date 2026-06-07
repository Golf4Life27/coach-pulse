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

describe("12724 STRATHMOOR FIXTURE — pessimistic-bound rule (2026-06-07 ratchet-unfreeze test)", () => {
  it("rehab band $22,814–$37,073 → pessimistic uses $37,073 → MAO $43,648 → fails $52k floor", () => {
    // Operator-pinned: ARV $132,675 (CMA $87/sf × 1525sf), rehab HIGH
    // $37,073 (vision band high — conf 42 low-confidence so the worst case
    // rules), fee $5k, ARV%Max 64.61% (Detroit). The dossier verdict
    // for 12724 MUST be fails_floor against the $52k sticky floor.
    const r = computePessimisticMao({
      conservativeArv: 132_675,
      rehabHigh: 37_073, // HIGH of $22,814–$37,073 — NEVER the LOW
      arvPctMax: 0.6461,
      stickyFloor: 52_000,
    });
    // $132,675 × 0.6461 = $85,721; − $37,073 − $5,000 = $43,648.
    expect(r.pessimisticMao).toBe(43_648);
    expect(r.verdict).toBe("fails_floor");
    expect(r.marginOverFloor).toBe(-8_352);
  });

  it("inversion guard: selecting the LOW end ($22,814) WOULD flip the verdict — pinned to prevent regression", () => {
    // The exact bug: if we wired effectiveRehabHigh = LOW of band, MAO
    // jumps from $43,648 to $58,907 (clears $52k as 'robust'). This
    // assertion documents the wrong answer so a future regression is
    // obvious in diff review.
    const wrong = computePessimisticMao({
      conservativeArv: 132_675,
      rehabHigh: 22_814,  // ← THE BUG SHAPE: low-end mislabeled "pessimistic"
      arvPctMax: 0.6461,
      stickyFloor: 52_000,
    });
    expect(wrong.pessimisticMao).toBe(57_907);  // not $43,648
    expect(wrong.verdict).not.toBe("fails_floor");
    // The above is what the inversion produced; the assertion stays as
    // a tripwire — if any future caller passes the LOW end as "high",
    // the dossier route's max(...) logic must catch it before it gets here.
  });
});
