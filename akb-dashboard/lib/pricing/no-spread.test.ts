import { describe, it, expect } from "vitest";
import { classifyNoSpread, NO_SPREAD_STATUS } from "./no-spread";

// The seven real Detroit records that drove this, with their ZIP seed $/sqft.
const DETROIT_NO_SPREAD = [
  { name: "16172 Cruse", listPrice: 109_000, sqft: 1_134, seedPsf: 92 },  // ARV 104,328
  { name: "15871 Tracey", listPrice: 80_000, sqft: 980, seedPsf: 71 },    // ARV  69,580
  { name: "15724 Fielding", listPrice: 69_900, sqft: 814, seedPsf: 62 },  // ARV  50,468
  { name: "1671 W Buena Vista", listPrice: 82_900, sqft: 1_680, seedPsf: 39 },
  { name: "19216 Hickory", listPrice: 89_900, sqft: 820, seedPsf: 68 },
  { name: "19947 Heyden", listPrice: 179_900, sqft: 1_130, seedPsf: 108 },
  { name: "150 W Hildale", listPrice: 257_000, sqft: 1_699, seedPsf: 86 },
];

// The three that SEND — these must never be parked.
const DETROIT_SENDS = [
  { name: "19139 Kingsville", listPrice: 115_000, sqft: 1_600, seedPsf: 118 },
  { name: "11635 Penrod", listPrice: 72_800, sqft: 1_400, seedPsf: 92 },
  { name: "4102 Somerset", listPrice: 69_900, sqft: 1_210, seedPsf: 112 },
];

describe("classifyNoSpread — the measured Detroit split", () => {
  it("parks all 7 records asking at or above their renovated value", () => {
    for (const r of DETROIT_NO_SPREAD) {
      const v = classifyNoSpread({ outreachStatus: null, ...r });
      expect(v.action, r.name).toBe("park");
      expect(v.arv!, r.name).toBeLessThanOrEqual(r.listPrice);
    }
  });

  it("leaves all 3 sendable records alone", () => {
    for (const r of DETROIT_SENDS) {
      expect(classifyNoSpread({ outreachStatus: null, ...r }).action, r.name).toBe("leave");
    }
  });
});

describe("it revives on a price cut — that is the whole point of the label", () => {
  it("clears No Spread once the ask drops below renovated value", () => {
    // 16172 Cruse: ARV $104,328. Seller cuts $109,000 → $95,000.
    const v = classifyNoSpread({
      outreachStatus: NO_SPREAD_STATUS, listPrice: 95_000, sqft: 1_134, seedPsf: 92,
    });
    expect(v.action).toBe("revive");
  });

  it("keeps it parked while the ask still exceeds value", () => {
    const v = classifyNoSpread({
      outreachStatus: NO_SPREAD_STATUS, listPrice: 106_000, sqft: 1_134, seedPsf: 92,
    });
    expect(v.action).toBe("leave");
    expect(v.reason).toContain("still no spread");
  });

  it("does not re-park a record it already parked", () => {
    const v = classifyNoSpread({
      outreachStatus: NO_SPREAD_STATUS, listPrice: 109_000, sqft: 1_134, seedPsf: 92,
    });
    expect(v.action).toBe("leave");
  });
});

describe("it never touches a record in a conversation", () => {
  // The failure this guards: a live negotiation silently relabelled, losing
  // both the history and the deal.
  for (const status of ["Texted", "Negotiating", "Response Received", "Offer Accepted", "Dead", "Counter Received"]) {
    it(`leaves '${status}' alone even with no spread`, () => {
      const v = classifyNoSpread({ outreachStatus: status, listPrice: 109_000, sqft: 1_134, seedPsf: 92 });
      expect(v.action).toBe("leave");
      expect(v.reason).toContain("not writable");
    });
  }
});

describe("it fails to 'leave' on anything it cannot judge", () => {
  const base = { outreachStatus: null, listPrice: 109_000, sqft: 1_134, seedPsf: 92 };
  it("no sqft", () => {
    expect(classifyNoSpread({ ...base, sqft: null }).action).toBe("leave");
  });
  it("no seed — an unseeded or DONT_PRICE ZIP", () => {
    expect(classifyNoSpread({ ...base, seedPsf: null }).action).toBe("leave");
    expect(classifyNoSpread({ ...base, seedPsf: 0 }).action).toBe("leave");
  });
  it("no list price", () => {
    expect(classifyNoSpread({ ...base, listPrice: null }).action).toBe("leave");
  });
  it("a seed-store outage cannot empty the pipeline", () => {
    // Every record unjudgeable → every record left alone, nothing parked.
    const all = [...DETROIT_NO_SPREAD, ...DETROIT_SENDS].map((r) =>
      classifyNoSpread({ outreachStatus: null, ...r, seedPsf: null }),
    );
    expect(all.every((v) => v.action === "leave")).toBe(true);
  });
});

describe("the margin is exactly zero — only the impossible is parked", () => {
  it("parks at exactly 100% of renovated value", () => {
    expect(classifyNoSpread({ outreachStatus: null, listPrice: 104_328, sqft: 1_134, seedPsf: 92 }).action)
      .toBe("park");
  });
  it("leaves a house worth one dollar more than the ask", () => {
    expect(classifyNoSpread({ outreachStatus: null, listPrice: 104_327, sqft: 1_134, seedPsf: 92 }).action)
      .toBe("leave");
  });
});
