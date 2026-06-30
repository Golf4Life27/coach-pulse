import { describe, it, expect } from "vitest";
import { roundOfferToNearest, OFFER_ROUND_STEP_USD } from "./offer-rounding";

describe("roundOfferToNearest — every cash offer rounds to the nearest $250", () => {
  it("the operator's example: 16,535 → 16,500", () => {
    expect(roundOfferToNearest(16_535)).toBe(16_500);
  });

  it("rounds UP when past the band midpoint: 16,700 → 16,750", () => {
    // 16,700 is 200 above 16,500 and 50 below 16,750 → nearest is 16,750.
    expect(roundOfferToNearest(16_700)).toBe(16_750);
  });

  it("exact $250 multiples are unchanged", () => {
    expect(roundOfferToNearest(16_500)).toBe(16_500);
    expect(roundOfferToNearest(250)).toBe(250);
  });

  it("a sub-$125 positive opener rounds to 0 so the caller HOLDs it", () => {
    expect(roundOfferToNearest(100)).toBe(0);
  });

  it("non-finite / ≤ 0 inputs pass through unchanged (callers gate those)", () => {
    expect(roundOfferToNearest(0)).toBe(0);
    expect(roundOfferToNearest(-5)).toBe(-5);
    expect(Number.isNaN(roundOfferToNearest(NaN))).toBe(true);
  });

  it("the business rule step is $250", () => {
    expect(OFFER_ROUND_STEP_USD).toBe(250);
  });
});
