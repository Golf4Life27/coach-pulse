// Proof tests for the comp-anchored cash-offer MAO (the 70% rule).
//
// The whole point: this math is COPIED from a system that works (HMHW Fix &
// Flip Calc), and validated against (a) HMHW's own example numbers and (b) the
// operator's real CMAs. If it doesn't reproduce both, it's not done.

import { describe, it, expect } from "vitest";
import {
  computeFlipOffer,
  arvFromComps,
  rehabBySqft,
  FLIP_RULE_PCT,
  DEFAULT_ASSIGNMENT_FEE,
} from "./mao-flip";

describe("computeFlipOffer — faithful to HMHW's Fix & Flip Calc", () => {
  it("reproduces HMHW's own spreadsheet example to the dollar", () => {
    // From the sheet: ARV 180000, 70%, Rehab 80000 → MAO 44110; fee 10000 → Offer 34110.
    const r = computeFlipOffer({ arv: 180_000, rehab: 80_000, assignmentFee: 10_000 });
    expect(r.status).toBe("offer");
    expect(r.basis).toBe(126_000); // 180k × 0.70
    expect(r.closing).toBe(1_890); // 126k × 1.5%
    expect(r.mao).toBe(44_110); // (126k − 80k − 1,890)
    expect(r.offer).toBe(34_110); // MAO − 10k fee
  });
});

describe("computeFlipOffer — validates against the operator's CMAs", () => {
  it("BLACKMOOR lands on the napkin (~$41k), NOT the broken $84k", () => {
    // CMA: ARV ~$118k, ~$30k rehab. The broken system texted 0.65 × $130k
    // list = $84,240 — above both the as-is comps ($64.5k) AND this MAO.
    const r = computeFlipOffer({ arv: 118_000, rehab: 30_000, assignmentFee: 10_000 });
    expect(r.status).toBe("offer");
    expect(r.mao).toBe(51_361); // 70% of 118k − 30k − 1,239
    expect(r.offer).toBe(41_361); // MAO − 10k fee  ≈ the operator's ~$42k

    // The bug is gone: the new offer is far below the old list-anchored number…
    const OLD_BROKEN_OFFER = Math.round(0.65 * 130_000); // 84,500 (≈ what shipped)
    expect(r.offer!).toBeLessThan(OLD_BROKEN_OFFER * 0.6);
    // …and structurally can never exceed value.
    expect(r.offer!).toBeLessThan(118_000);
  });

  it("flags a deep-rehab cheapie as no_deal instead of forcing a number (Hoover-shaped)", () => {
    // Low ARV + heavy rehab doesn't pencil as a FLIP — the honest answer is
    // 'not a flip deal', i.e. route to the rental/creative model, not a guess.
    const r = computeFlipOffer({ arv: 61_000, rehab: rehabBySqft(892, "heavy")!, assignmentFee: 10_000 });
    expect(r.status).toBe("no_deal");
    expect(r.offer!).toBeLessThanOrEqual(0);
    expect(r.reason).toMatch(/rental\/creative/i);
  });
});

describe("computeFlipOffer — structural guards (the bug cannot recur)", () => {
  it("HOLDS when ARV is missing, and NEVER falls back to list price", () => {
    for (const arv of [null, undefined, 0, -5, NaN]) {
      const r = computeFlipOffer({ arv, rehab: 30_000 });
      expect(r.status).toBe("hold");
      expect(r.offer).toBeNull();
      expect(r.reason).toMatch(/never anchored to the list/i);
    }
  });

  it("HOLDS when rehab is missing, but accepts $0 rehab (fully flipped)", () => {
    expect(computeFlipOffer({ arv: 120_000, rehab: null }).status).toBe("hold");
    expect(computeFlipOffer({ arv: 120_000, rehab: undefined }).status).toBe("hold");
    const flipped = computeFlipOffer({ arv: 120_000, rehab: 0, assignmentFee: 5_000 });
    expect(flipped.status).toBe("offer");
    expect(flipped.rehab).toBe(0);
  });

  it("OVER-VALUE GUARD: the offer can never exceed the property's value", () => {
    // The single check that would have killed the $84k-on-a-$64.5k-house bug.
    const cases = [
      { arv: 50_000, rehab: 0 },
      { arv: 100_000, rehab: 10_000 },
      { arv: 250_000, rehab: 60_000 },
      { arv: 118_000, rehab: 30_000 },
      { arv: 1_000_000, rehab: 0 },
    ];
    for (const c of cases) {
      const r = computeFlipOffer({ ...c, assignmentFee: 0 });
      if (r.offer == null) continue;
      expect(r.offer).toBeLessThan(c.arv); // offer < value, always
      expect(r.mao!).toBeLessThanOrEqual(r.basis!); // mao ≤ 70%-of-ARV
      expect(r.basis!).toBeLessThan(c.arv); // basis < ARV (rule < 100%)
    }
  });

  it("uses the documented defaults (70% rule, $10k fee)", () => {
    const r = computeFlipOffer({ arv: 200_000, rehab: 0 });
    expect(r.rulePctUsed).toBe(FLIP_RULE_PCT);
    expect(r.assignmentFeeUsed).toBe(DEFAULT_ASSIGNMENT_FEE);
    expect(FLIP_RULE_PCT).toBe(0.7);
    expect(DEFAULT_ASSIGNMENT_FEE).toBe(10_000);
  });
});

describe("arvFromComps — ARV = SqFt × avg comp $/sqft (HMHW method)", () => {
  it("reproduces HMHW's averaged-comp example", () => {
    // sheet comps $/sqft: 314.78, 333.05, 248.33 → avg 298.72; subject 1108 sqft.
    expect(arvFromComps(1108, [314.781022, 333.047945, 248.328558])).toBe(330_981);
  });
  it("simple case: 1,850 sqft × $150/sqft × 3 comps", () => {
    expect(arvFromComps(1850, [150, 150, 150])).toBe(277_500);
  });
  it("ignores blank/zero comps and averages only the real ones", () => {
    expect(arvFromComps(1000, [100, null, 0, 200, undefined])).toBe(150_000); // avg(100,200)=150
  });
  it("returns null (never fabricates) when sqft or comps are unusable", () => {
    expect(arvFromComps(null, [150])).toBeNull();
    expect(arvFromComps(1000, [])).toBeNull();
    expect(arvFromComps(1000, [null, 0])).toBeNull();
  });
});

describe("rehabBySqft — condition tier × sqft (HMHW Rehab Estimator)", () => {
  it("applies each tier rate", () => {
    expect(rehabBySqft(1200, "very_light")).toBe(6_000); // ×5
    expect(rehabBySqft(1200, "light")).toBe(18_000); // ×15
    expect(rehabBySqft(1200, "medium")).toBe(36_000); // ×30
    expect(rehabBySqft(1200, "heavy")).toBe(84_000); // ×70
  });
  it("fully_flipped is $0 even with no sqft; other tiers need sqft", () => {
    expect(rehabBySqft(null, "fully_flipped")).toBe(0);
    expect(rehabBySqft(null, "medium")).toBeNull();
  });
});

describe("end-to-end — comps → ARV → offer", () => {
  it("chains the helpers into a sendable offer", () => {
    const arv = arvFromComps(1500, [120, 130, 110]); // avg 120 × 1500 = 180,000
    const rehab = rehabBySqft(1500, "medium"); // 45,000
    const r = computeFlipOffer({ arv, rehab, assignmentFee: 8_000 });
    expect(arv).toBe(180_000);
    expect(rehab).toBe(45_000);
    expect(r.status).toBe("offer");
    // 70% of 180k = 126k; −45k −1,890 closing = 79,110 MAO; −8k fee = 71,110.
    expect(r.mao).toBe(79_110);
    expect(r.offer).toBe(71_110);
  });
});
