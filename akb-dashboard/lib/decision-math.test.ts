import { describe, it, expect } from "vitest";
import {
  computeDecisionMath,
  suggestExitLane,
  decisionInputsHash,
  resolveCurrentPrice,
  rollupConfidence,
  SPREAD_FLOOR_USD,
  SPREAD_TARGET_USD,
  VISION_CONF_CUTLINE,
  type DecisionRecordInputs,
} from "./decision-math";

const EMPTY: DecisionRecordInputs = {
  arv: null,
  arvConfidence: null,
  rehabMid: null,
  rehabConfidenceScore: null,
  contractOfferPrice: null,
  latestCounterUsd: null,
  roughOpenerAmount: null,
  outreachOfferPrice: null,
  listPrice: null,
  wholesaleFeeTarget: null,
  yourMaoV21: null,
  investorMaoV21: null,
};

describe("the three live records (2026-07-13 discovery) — un-underwritten", () => {
  it("Mayfield class: opener + counter but NO ARV/rehab → NEEDS_DATA naming both", () => {
    const r = computeDecisionMath({
      ...EMPTY,
      listPrice: 29_900,
      roughOpenerAmount: 25_415,
      latestCounterUsd: 27_000,
    });
    expect(r.verdict).toBe("NEEDS_DATA");
    expect(r.reason).toMatch(/ARV/);
    expect(r.reason).toMatch(/rehab/);
    // The counter is still surfaced as the live price even while holding.
    expect(r.currentPrice).toBe(27_000);
    expect(r.priceSource).toBe("counter");
    expect(r.buyerCeiling).toBeNull();
    expect(r.dealSpread).toBeNull();
  });
});

describe("flip waterfall matches mao-flip ground truth (codebase over brief)", () => {
  // ARV 100k, rehab 20k, fee 10k:
  //   basis = 70,000; closing = 1,050; buyer ceiling (mao) = 48,950; your MAO = 38,950
  const UW: DecisionRecordInputs = {
    ...EMPTY,
    arv: 100_000,
    arvConfidence: "HIGH",
    rehabMid: 20_000,
    rehabConfidenceScore: 80,
    roughOpenerAmount: 30_000,
  };

  it("buyer ceiling includes the closing deduction (basis − rehab − closing)", () => {
    const r = computeDecisionMath(UW);
    expect(r.waterfall.basis).toBe(70_000);
    expect(r.waterfall.closing).toBe(1_050);
    expect(r.buyerCeiling).toBe(48_950);
    expect(r.yourMao).toBe(38_950);
    expect(r.ceilingLane).toBe("flip");
  });

  it("GO: spread ≥ target, price ≤ MAO, all-in ≤ 70%", () => {
    const r = computeDecisionMath(UW);
    // spread = 48,950 − 30,000 = 18,950 ≥ 10k; all-in = 50k/100k = 0.5
    expect(r.dealSpread).toBe(18_950);
    expect(r.allInPctArv).toBe(0.5);
    expect(r.verdict).toBe("GO");
  });

  it("TIGHT: spread in [floor, target) with price still ≤ MAO (fee target $5k)", () => {
    // With fee = $10k (= spread target) TIGHT is unreachable on the flip
    // lane: any sub-target spread implies price > yourMao → PASS wins. A $5k
    // fee target opens the band: yourMao = 43,950; price 41k → spread 7,950.
    const r = computeDecisionMath({ ...UW, wholesaleFeeTarget: 5_000, roughOpenerAmount: 41_000 });
    expect(r.yourMao).toBe(43_950);
    expect(r.dealSpread).toBe(7_950);
    expect(r.verdict).toBe("TIGHT");
    expect(r.dealSpread!).toBeGreaterThanOrEqual(SPREAD_FLOOR_USD);
    expect(r.dealSpread!).toBeLessThan(SPREAD_TARGET_USD);
  });

  it("PASS: spread below floor, reason says so", () => {
    const r = computeDecisionMath({ ...UW, roughOpenerAmount: 46_000 });
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/floor/);
  });

  it("PASS: counter above MAO kills it even with fat nominal spread math", () => {
    // Counter 45k > yourMao 38,950 → PASS regardless of remaining spread
    const r = computeDecisionMath({ ...UW, latestCounterUsd: 45_000 });
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/MAO/);
  });

  it("PASS: all-in above the 70% line", () => {
    // price 55k + rehab 20k = 75k all-in on 100k ARV = 75% > 70%
    const r = computeDecisionMath({ ...UW, roughOpenerAmount: 55_000 });
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/all-in/);
  });
});

describe("confidence gates (never a confident verdict on a guessed number)", () => {
  const UW: DecisionRecordInputs = {
    ...EMPTY,
    arv: 100_000,
    arvConfidence: "HIGH",
    rehabMid: 20_000,
    rehabConfidenceScore: 80,
    roughOpenerAmount: 30_000,
  };

  it(`rehab vision conf < ${VISION_CONF_CUTLINE} → HOLD_LOW_CONF with the score named`, () => {
    const r = computeDecisionMath({ ...UW, rehabConfidenceScore: 42 });
    expect(r.verdict).toBe("HOLD_LOW_CONF");
    expect(r.reason).toMatch(/42/);
    // Math still computed for the card — just not trusted.
    expect(r.buyerCeiling).toBe(48_950);
  });

  it("ARV LOW → HOLD_LOW_CONF (manual comp review)", () => {
    const r = computeDecisionMath({ ...UW, arvConfidence: "LOW" });
    expect(r.verdict).toBe("HOLD_LOW_CONF");
    expect(r.reason).toMatch(/comp/i);
  });

  it("non-vision rehab (null score) does NOT hold — Med leg", () => {
    const r = computeDecisionMath({ ...UW, rehabConfidenceScore: null });
    expect(r.verdict).toBe("GO");
    expect(r.confidence).toBe("Med");
  });

  it("rollup: High needs both legs high; any Low leg → Low", () => {
    expect(rollupConfidence("HIGH", 80)).toBe("High");
    expect(rollupConfidence("HIGH", 42)).toBe("Low");
    expect(rollupConfidence("LOW", 90)).toBe("Low");
    expect(rollupConfidence("MED", 75)).toBe("Med");
  });
});

describe("current-price chain (operator fields never guessed over)", () => {
  it("contract > counter > opener > legacy echo", () => {
    expect(
      resolveCurrentPrice({ contractOfferPrice: 1, latestCounterUsd: 2, roughOpenerAmount: 3, outreachOfferPrice: 4 }),
    ).toEqual({ price: 1, source: "contract" });
    expect(
      resolveCurrentPrice({ contractOfferPrice: null, latestCounterUsd: 2, roughOpenerAmount: 3, outreachOfferPrice: 4 }),
    ).toEqual({ price: 2, source: "counter" });
    expect(
      resolveCurrentPrice({ contractOfferPrice: null, latestCounterUsd: null, roughOpenerAmount: 3, outreachOfferPrice: 4 }),
    ).toEqual({ price: 3, source: "opener" });
    expect(
      resolveCurrentPrice({ contractOfferPrice: null, latestCounterUsd: null, roughOpenerAmount: null, outreachOfferPrice: null }),
    ).toEqual({ price: null, source: "none" });
  });
});

describe("landlord lane governs when its ceiling is higher", () => {
  it("Investor_MAO_V21 above the flip ceiling → landlord lane + Your_MAO_V21", () => {
    const r = computeDecisionMath({
      ...EMPTY,
      arv: 100_000,
      arvConfidence: "MED",
      rehabMid: 20_000,
      rehabConfidenceScore: 70,
      roughOpenerAmount: 30_000,
      investorMaoV21: 60_000, // > flip ceiling 48,950
      yourMaoV21: 52_000,
    });
    expect(r.ceilingLane).toBe("landlord");
    expect(r.buyerCeiling).toBe(60_000);
    expect(r.yourMao).toBe(52_000);
    expect(r.dealSpread).toBe(30_000);
  });
});

describe("inputs hash — ±$5 recompute tolerance (doctrine standard 1)", () => {
  const UW: DecisionRecordInputs = {
    ...EMPTY,
    arv: 100_000,
    arvConfidence: "HIGH",
    rehabMid: 20_000,
    rehabConfidenceScore: 80,
    roughOpenerAmount: 30_000,
  };

  it("a $2 wiggle is the SAME hash (no churn); a $500 move is a new hash", () => {
    const h0 = decisionInputsHash(UW);
    expect(decisionInputsHash({ ...UW, arv: 100_002 })).toBe(h0);
    expect(decisionInputsHash({ ...UW, arv: 100_500 })).not.toBe(h0);
  });

  it("a fresh counter changes the hash (verdict must refresh)", () => {
    const h0 = decisionInputsHash(UW);
    expect(decisionInputsHash({ ...UW, latestCounterUsd: 27_000 })).not.toBe(h0);
  });
});

// ── EXIT AUTO-SORT (2026-07-16) ─────────────────────────────────────────────
describe("suggestExitLane — every deal lands labeled with its close type", () => {
  it("GO/TIGHT on the flip lane → wholesale; landlord lane → rental", () => {
    expect(suggestExitLane({ verdict: "GO", ceilingLane: "flip", currentPrice: 80_000 }, {})).toBe("wholesale");
    expect(suggestExitLane({ verdict: "TIGHT", ceilingLane: "flip", currentPrice: 80_000 }, {})).toBe("wholesale");
    expect(suggestExitLane({ verdict: "GO", ceilingLane: "landlord", currentPrice: 80_000 }, {})).toBe("rental");
  });
  it("PASS + strong rent (≥0.9% of price) → creative_candidate; weak rent → dead", () => {
    expect(suggestExitLane({ verdict: "PASS", ceilingLane: "flip", currentPrice: 150_000 }, { estimatedMonthlyRent: 2_420 })).toBe("creative_candidate");
    expect(suggestExitLane({ verdict: "PASS", ceilingLane: "flip", currentPrice: 150_000 }, { estimatedMonthlyRent: 900 })).toBe("dead");
    expect(suggestExitLane({ verdict: "PASS", ceilingLane: "flip", currentPrice: 150_000 }, {})).toBe("dead");
  });
  it("NEEDS_DATA / HOLD_LOW_CONF → unknown (never sort untrusted math)", () => {
    expect(suggestExitLane({ verdict: "NEEDS_DATA", ceilingLane: null, currentPrice: null }, { estimatedMonthlyRent: 5_000 })).toBe("unknown");
    expect(suggestExitLane({ verdict: "HOLD_LOW_CONF", ceilingLane: "flip", currentPrice: 50_000 }, { estimatedMonthlyRent: 5_000 })).toBe("unknown");
  });
  it("computeDecisionMath carries the lane end-to-end", () => {
    const r = computeDecisionMath({
      arv: 190_000, arvConfidence: "HIGH", rehabMid: 36_881, rehabConfidenceScore: 90,
      contractOfferPrice: 75_000, latestCounterUsd: null, roughOpenerAmount: null,
      outreachOfferPrice: null, listPrice: 150_000, wholesaleFeeTarget: 15_000,
      yourMaoV21: null, investorMaoV21: null, estimatedMonthlyRent: null,
    });
    expect(r.verdict).toBe("GO");
    expect(r.suggestedExit).toBe("wholesale");
  });
});
