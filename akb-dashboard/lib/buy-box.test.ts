import { describe, it, expect } from "vitest";
import {
  maoFor,
  askPencils,
  maxAskFor,
  tierForCity,
  hasAny,
  MAX_ASK_ANY_MARKET,
  LANDLORD_PITCH_KEYWORDS,
  DISTRESS_KEYWORDS,
  EXCLUDE_KEYWORDS,
  MF_COC_JUMP,
  MF_COC_FLOOR,
} from "./buy-box";

describe("the ask ceiling actually binds", () => {
  it("is far below the $400,000 that let six-figure junk in", () => {
    expect(MAX_ASK_ANY_MARKET).toBeLessThan(400_000);
    expect(maxAskFor("Detroit")).toBe(90_000);
    expect(maxAskFor("Atlanta")).toBe(150_000);
  });

  it("rejects the listing that produced the $266,250 offer", () => {
    // 1909 Flat Shoals Rd SE, Atlanta — list $375,000.
    expect(375_000).toBeGreaterThan(maxAskFor("Atlanta"));
  });

  it("falls back to the global cap for an unknown market", () => {
    expect(tierForCity("Boise")).toBeNull();
    expect(maxAskFor("Boise")).toBe(MAX_ASK_ANY_MARKET);
  });
});

describe("the deal test", () => {
  it("computes the most we can pay and still clear a fee", () => {
    // 0.70*150k - 35k - 10k
    expect(maoFor({ arv: 150_000, rehab: 35_000 })).toBe(60_000);
  });

  it("says no when the ask eats the spread", () => {
    expect(askPencils({ ask: 90_000, arv: 150_000, rehab: 35_000 })).toBe(false);
    expect(askPencils({ ask: 55_000, arv: 150_000, rehab: 35_000 })).toBe(true);
  });

  it("never returns a negative ceiling", () => {
    expect(maoFor({ arv: 60_000, rehab: 80_000 })).toBe(0);
  });

  it("kills 2943 Hillside on the numbers", () => {
    // $136,000 ask, 46218 Indianapolis. Even at a generous $180k ARV and a
    // light $25k rehab the ceiling is $91k — a $45k gap.
    expect(askPencils({ ask: 136_000, arv: 180_000, rehab: 25_000 })).toBe(false);
  });
});

describe("copy screening", () => {
  it("treats 'investor special' as distress, not exclusion", () => {
    expect(hasAny("Investor special, sold as-is", DISTRESS_KEYWORDS)).toBe(true);
    expect(hasAny("Investor special, sold as-is", EXCLUDE_KEYWORDS)).toBe(false);
  });

  it("flags landlord-yield marketing — priced for the buyer we would assign TO", () => {
    const hillside =
      "ideal for investors seeking stable cash flow or buyers needing four bedrooms... " +
      "whether you're expanding a rental portfolio";
    expect(hasAny(hillside, LANDLORD_PITCH_KEYWORDS)).toBe(true);
    expect(hasAny(hillside, DISTRESS_KEYWORDS)).toBe(false);
  });

  it("excludes listings closed to us and already-renovated stock", () => {
    expect(hasAny("No wholesalers please", EXCLUDE_KEYWORDS)).toBe(true);
    expect(hasAny("Fully renovated top to bottom", EXCLUDE_KEYWORDS)).toBe(true);
  });
});

describe("operator rulings carried, not re-derived", () => {
  it("keeps the 2026-08-01 cash-on-cash tiers", () => {
    expect(MF_COC_JUMP).toBe(0.12);
    expect(MF_COC_FLOOR).toBe(0.10);
  });
});
