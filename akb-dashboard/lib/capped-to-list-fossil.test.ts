import { describe, it, expect } from "vitest";
import { isCappedToListFossil, CAPPED_RATIO, CAPPED_TOLERANCE } from "./capped-to-list-fossil";

// The audit that produced this: 808 of 819 records carrying both an opener and
// a list price had an opener EXACTLY 0.65 x list and NO Opener_Basis. 23 of a
// recomputed sample of 40 offered MORE than their own ARV supported.
describe("isCappedToListFossil — catch the fossil, nothing else", () => {
  it("catches an exact 0.65-of-list opener with no basis", () => {
    // 15875 Strathmoor, a real row: list $79,000, stored opener $51,350.
    expect(isCappedToListFossil({ listPrice: 79_000, offer: 51_350, openerBasis: null })).toBe(true);
    // 11383 Ohio — the one whose ARV-derived MAO computes to MINUS $85.
    expect(isCappedToListFossil({ listPrice: 22_500, offer: 14_625, openerBasis: "" })).toBe(true);
  });

  it("SPARES a record that names its basis, even at the same ratio", () => {
    // The corroborating fact. Every modern priced record names how it was
    // derived; none of the 808 do. A basis means the number was produced by
    // the value-anchored path and must survive regardless of what ratio it
    // happens to land on.
    expect(
      isCappedToListFossil({ listPrice: 79_000, offer: 51_350, openerBasis: "arv_buybox_seed" }),
    ).toBe(false);
  });

  it("SPARES value-anchored openers at other ratios", () => {
    // 8235 Prest St: $26,000 on a $75,900 list = 34.3%, derived from a STRONG
    // seed. Exactly the population that must not be touched.
    expect(isCappedToListFossil({ listPrice: 75_900, offer: 26_000, openerBasis: null })).toBe(false);
    expect(isCappedToListFossil({ listPrice: 55_000, offer: 16_500, openerBasis: null })).toBe(false);
    expect(isCappedToListFossil({ listPrice: 346_000, offer: 248_500, openerBasis: null })).toBe(false);
  });

  it("refuses to act on missing or nonsense numbers", () => {
    expect(isCappedToListFossil({ listPrice: null, offer: 51_350, openerBasis: null })).toBe(false);
    expect(isCappedToListFossil({ listPrice: 79_000, offer: null, openerBasis: null })).toBe(false);
    expect(isCappedToListFossil({ listPrice: 0, offer: 0, openerBasis: null })).toBe(false);
    expect(isCappedToListFossil({ listPrice: -79_000, offer: -51_350, openerBasis: null })).toBe(false);
    expect(isCappedToListFossil({ listPrice: "79000", offer: "51350", openerBasis: null })).toBe(false);
    expect(isCappedToListFossil({ listPrice: NaN, offer: NaN, openerBasis: null })).toBe(false);
  });

  it("holds the tolerance tight — this deletes operator data", () => {
    expect(CAPPED_RATIO).toBe(0.65);
    expect(CAPPED_TOLERANCE).toBe(0.005);
    // 0.66 is NOT the fossil.
    expect(isCappedToListFossil({ listPrice: 100_000, offer: 66_000, openerBasis: null })).toBe(false);
    expect(isCappedToListFossil({ listPrice: 100_000, offer: 64_000, openerBasis: null })).toBe(false);
    // ...but rounding inside half a percent still is.
    expect(isCappedToListFossil({ listPrice: 100_000, offer: 65_400, openerBasis: null })).toBe(true);
  });
});
