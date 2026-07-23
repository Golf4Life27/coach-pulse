import { describe, it, expect } from "vitest";
import { adjustedArvFromComps } from "./comp-adjustment";

describe("adjustedArvFromComps — size-adjusted, similarity-weighted sales comparison", () => {
  it("returns null with no usable comps or invalid subject sqft", () => {
    expect(adjustedArvFromComps([], 1500)).toBeNull();
    expect(adjustedArvFromComps([{ price: 0, sqft: 1000 }], 1500)).toBeNull();
    expect(adjustedArvFromComps([{ price: 100000, sqft: 1000 }], null)).toBeNull();
  });

  it("scales SUB-LINEARLY with size — a 2× bigger subject is NOT worth 2× (kills the flat-$/sqft bug)", () => {
    // 4 identical $100k / 1,000 sqft comps ($100/sqft). Flat math → 2,000 sqft
    // = $200k. Sub-linear (β<1) must come in BELOW that.
    const comps = [
      { price: 100_000, sqft: 1_000 }, { price: 100_000, sqft: 1_000 },
      { price: 100_000, sqft: 1_000 }, { price: 100_000, sqft: 1_000 },
    ];
    const r = adjustedArvFromComps(comps, 2_000)!;
    expect(r.arv).toBeLessThan(200_000);
    expect(r.arv).toBeGreaterThan(150_000); // still rises with size, just sub-linearly
    expect(r.quality).toBe("extrapolated"); // subject is 2× the comp size
  });

  it("brackets a subject that sits inside the comp size range", () => {
    const comps = [
      { price: 150_000, sqft: 1_500 },
      { price: 250_000, sqft: 2_500 },
      { price: 200_000, sqft: 2_000 },
    ];
    const r = adjustedArvFromComps(comps, 2_000)!;
    expect(r.quality).toBe("bracketed");
    expect(r.arv).toBeGreaterThan(180_000);
    expect(r.arv).toBeLessThan(220_000);
  });

  it("927 Avon: adjusted ARV is materially BELOW the flat-$/sqft number that over-offered", () => {
    // 44310 comps (all ~1,000 sqft) vs the 2,605 sqft subject. Flat: 134 × 2605
    // = $349,070. The sub-linear adjustment must land well under that (the gate
    // still HOLDs it as extrapolated — this just proves the math no longer
    // fabricates the same inflated number).
    const comps = [
      { price: 180_000, sqft: 978 }, { price: 145_000, sqft: 988 },
      { price: 163_000, sqft: 1_236 }, { price: 139_900, sqft: 1_133 },
      { price: 115_000, sqft: 991 }, { price: 104_000, sqft: 1_040 },
      { price: 131_000, sqft: 987 },
    ];
    const r = adjustedArvFromComps(comps, 2_605)!;
    expect(r.arv).toBeLessThan(349_070);
    expect(r.quality).toBe("extrapolated");
  });
});
