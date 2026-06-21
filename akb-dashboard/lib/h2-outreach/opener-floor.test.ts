// Opener floor (basis A) — unit tests.

import { describe, it, expect } from "vitest";
import { computeOpenerFloor } from "./opener-floor";

const FEE = 5000;
const MIN_N = 20;

describe("computeOpenerFloor (basis A: Buyer_Median − fee)", () => {
  it("caps the door-opener when median − fee < base (the floor bites)", () => {
    // 16713 Glastonbury: base $161,935, 48219 landlord $77,500 (n=60).
    const r = computeOpenerFloor({ baseOpener: 161935, buyerMedian: 77500, medianN: 60, wholesaleFee: FEE, minN: MIN_N });
    expect(r.floorProxy).toBe(72500); // 77,500 − 5,000
    expect(r.floorBit).toBe(true);
    expect(r.flooredOpener).toBe(72500);
  });

  it("passes the opener through when median − fee ≥ base (floor does not bite)", () => {
    // 19358 Evergreen: base $61,495, 48219 landlord $77,500 → floor $72,500 > base.
    const r = computeOpenerFloor({ baseOpener: 61495, buyerMedian: 77500, medianN: 60, wholesaleFee: FEE, minN: MIN_N });
    expect(r.floorProxy).toBe(72500);
    expect(r.floorBit).toBe(false);
    expect(r.flooredOpener).toBe(61495); // unchanged door-opener
  });

  it("fails OPEN (no cap) when the ZIP/track has no seeded median", () => {
    const r = computeOpenerFloor({ baseOpener: 50000, buyerMedian: null, medianN: null, wholesaleFee: FEE, minN: MIN_N });
    expect(r.floorProxy).toBeNull();
    expect(r.floorBit).toBe(false);
    expect(r.flooredOpener).toBe(50000);
  });

  it("fails OPEN when the median is thin (n < minN) — never floors on weak data", () => {
    const r = computeOpenerFloor({ baseOpener: 50000, buyerMedian: 30000, medianN: 12, wholesaleFee: FEE, minN: MIN_N });
    expect(r.floorProxy).toBeNull();
    expect(r.floorBit).toBe(false);
    expect(r.flooredOpener).toBe(50000);
  });

  it("does not cap when median − fee equals the base exactly", () => {
    const r = computeOpenerFloor({ baseOpener: 25000, buyerMedian: 30000, medianN: 25, wholesaleFee: FEE, minN: MIN_N });
    expect(r.floorProxy).toBe(25000);
    expect(r.floorBit).toBe(false); // not strictly below
    expect(r.flooredOpener).toBe(25000);
  });

  it("flags belowLowballFloor when the floor mis-caps an above-median house deep (<35% list)", () => {
    // 4357 W Philadelphia: base $123,055, 48204 landlord $42,000 → floor $37,000,
    // list $189,900 → 19.5% of list. The ZIP median can't price this $170k house.
    const r = computeOpenerFloor({ baseOpener: 123055, buyerMedian: 42000, medianN: 55, wholesaleFee: FEE, minN: MIN_N, listPrice: 189900 });
    expect(r.flooredOpener).toBe(37000);
    expect(r.floorBit).toBe(true);
    expect(r.belowLowballFloor).toBe(true); // 37,000 < 0.35 × 189,900 = 66,465
  });

  it("does not flag belowLowballFloor when the floored offer is ≥ 35% of list", () => {
    // 17187 Vaughan: base $77,760, 48219 landlord $77,500 → floor $72,500,
    // list $120,000 → 60.4% of list.
    const r = computeOpenerFloor({ baseOpener: 77760, buyerMedian: 77500, medianN: 60, wholesaleFee: FEE, minN: MIN_N, listPrice: 120000 });
    expect(r.flooredOpener).toBe(72500);
    expect(r.floorBit).toBe(true);
    expect(r.belowLowballFloor).toBe(false); // 72,500 ≥ 0.35 × 120,000 = 42,000
  });

  it("leaves the lowball guard inert when listPrice is absent (fail-open)", () => {
    const r = computeOpenerFloor({ baseOpener: 50000, buyerMedian: 30000, medianN: 25, wholesaleFee: FEE, minN: MIN_N });
    expect(r.belowLowballFloor).toBe(false);
  });
});
