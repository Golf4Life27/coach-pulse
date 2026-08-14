import { describe, it, expect } from "vitest";
import { checkArvAgainstOwnComps, compPsfs, MIN_COMPS_FOR_CHECK } from "./arv-vs-own-comps";

/** The real 9360 Cheyenne comp array, trimmed to the shape the field stores.
 *  Median ~$55/sqft, highest print $95.04 — against a stored ARV of $154,177
 *  on 1,430 sqft ($107.81/sqft). */
const CHEYENNE_COMPS = JSON.stringify([
  { price: 95_000, sqft: 1_276, per_sqft: 74.45, formatted_address: "10030 HARTWELL" },
  { price: 100_000, sqft: 1_218, per_sqft: 82.1, formatted_address: "8590 LITTLEFIELD" },
  { price: 55_000, sqft: 1_307, per_sqft: 42.08, formatted_address: "8871 CHEYENNE" },
  { price: 115_000, sqft: 1_210, per_sqft: 95.04, formatted_address: "9630 STRATHMOOR" },
  { price: 82_863, sqft: 1_417, per_sqft: 58.48, formatted_address: "8250 ESPER" },
  { price: 70_000, sqft: 1_351, per_sqft: 51.81, formatted_address: "8560 WARD" },
  { price: 50_000, sqft: 1_486, per_sqft: 33.65, formatted_address: "9581 MARK TWAIN" },
  { price: 60_000, sqft: 1_298, per_sqft: 46.22, formatted_address: "9119 LITTLEFIELD" },
  { price: 64_000, sqft: 1_430, per_sqft: 44.76, formatted_address: "9360 CHEYENNE (subject)" },
  { price: 72_200, sqft: 1_487, per_sqft: 48.55, formatted_address: "9300 CHEYENNE" },
]);

describe("checkArvAgainstOwnComps — the 9360 Cheyenne case", () => {
  it("CATCHES the ARV that beats every comp on its own record", () => {
    const r = checkArvAgainstOwnComps({ arv: 154_177, sqft: 1_430, compsJson: CHEYENNE_COMPS });
    expect(r.checked).toBe(true);
    expect(r.outsideBand).toBe(true);
    expect(r.rail).toBe("above_every_comp");
    expect(r.subjectPsf).toBeCloseTo(107.81, 1);
    expect(r.maxPsf).toBeCloseTo(95.04, 1);
    expect(r.reason).toMatch(/exceeds EVERY one of this record's 10 comps/);
  });

  it("a defensible ARV on the same comps PASSES — the rail must not eat live deals", () => {
    // ~$78,650 is the median-psf read of this block. It is above the median
    // (renovated should be) and under the top print, so nothing trips.
    const r = checkArvAgainstOwnComps({ arv: 78_650, sqft: 1_430, compsJson: CHEYENNE_COMPS });
    expect(r.outsideBand).toBe(false);
    expect(r.rail).toBeNull();
  });
});

describe("the rails", () => {
  /** Median $50, max $60, min $40 — a tight, boring comp set. */
  const tight = JSON.stringify(
    [40, 45, 50, 50, 55, 60].map((psf, i) => ({ price: psf * 1_000, sqft: 1_000, formatted_address: `c${i}` })),
  );

  it("above_every_comp fires just past the top print", () => {
    const r = checkArvAgainstOwnComps({ arv: 61_000, sqft: 1_000, compsJson: tight });
    expect(r.rail).toBe("above_every_comp");
  });

  it("far_above_median catches an inflated ARV hiding under one wild high comp", () => {
    // One $200/sqft print lifts the max out of the way; the median still says $50.
    const withOutlier = JSON.stringify(
      [40, 45, 50, 50, 55, 60, 200].map((psf, i) => ({ price: psf * 1_000, sqft: 1_000, formatted_address: `c${i}` })),
    );
    const r = checkArvAgainstOwnComps({ arv: 95_000, sqft: 1_000, compsJson: withOutlier });
    expect(r.outsideBand).toBe(true);
    expect(r.rail).toBe("far_above_median");
    expect(r.ratioToMedian).toBeCloseTo(1.9, 1);
  });

  it("below_every_comp catches an as-is value parked in the ARV field", () => {
    const r = checkArvAgainstOwnComps({ arv: 35_000, sqft: 1_000, compsJson: tight });
    expect(r.rail).toBe("below_every_comp");
  });

  it("a renovated ARV comfortably above the median still passes (1.2×)", () => {
    const r = checkArvAgainstOwnComps({ arv: 60_000, sqft: 1_000, compsJson: tight });
    expect(r.outsideBand).toBe(false);
  });
});

describe("refuses to guess — unchecked is never a pass", () => {
  const five = JSON.stringify(
    [40, 45, 50, 55, 60].map((psf) => ({ price: psf * 1_000, sqft: 1_000 })),
  );

  it("no comps → unchecked, not clean", () => {
    const r = checkArvAgainstOwnComps({ arv: 100_000, sqft: 1_000, compsJson: null });
    expect(r.checked).toBe(false);
    expect(r.outsideBand).toBe(false);
    expect(r.reason).toMatch(/too_few_comps/);
  });

  it("below the comp-count floor → unchecked", () => {
    const four = JSON.stringify([40, 45, 50, 55].map((psf) => ({ price: psf * 1_000, sqft: 1_000 })));
    expect(checkArvAgainstOwnComps({ arv: 100_000, sqft: 1_000, compsJson: four }).checked).toBe(false);
    expect(checkArvAgainstOwnComps({ arv: 52_000, sqft: 1_000, compsJson: five }).checked).toBe(true);
    expect(MIN_COMPS_FOR_CHECK).toBe(5);
  });

  it("missing sqft or ARV → unchecked", () => {
    expect(checkArvAgainstOwnComps({ arv: 100_000, sqft: null, compsJson: five }).reason).toBe("no_sqft");
    expect(checkArvAgainstOwnComps({ arv: null, sqft: 1_000, compsJson: five }).reason).toBe("no_arv");
  });

  it("unparseable JSON is unchecked, never a silent pass", () => {
    const r = checkArvAgainstOwnComps({ arv: 100_000, sqft: 1_000, compsJson: "{not json" });
    expect(r.checked).toBe(false);
  });
});

describe("compPsfs — price÷sqft wins over a stored per_sqft", () => {
  it("ignores a wrong stored ratio", () => {
    const j = JSON.stringify([{ price: 100_000, sqft: 1_000, per_sqft: 999 }]);
    expect(compPsfs(j)).toEqual([100]);
  });

  it("falls back to per_sqft when price/sqft are unusable", () => {
    const j = JSON.stringify([{ price: 0, sqft: 0, per_sqft: 77 }]);
    expect(compPsfs(j)).toEqual([77]);
  });

  it("skips junk entries without throwing", () => {
    const j = JSON.stringify([null, 5, { price: 100_000, sqft: 1_000 }, { nothing: true }]);
    expect(compPsfs(j)).toEqual([100]);
  });
});
