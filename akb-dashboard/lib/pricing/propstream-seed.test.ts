// @agent: appraiser — PropStream MLS-sold seed tests.
//
// The fixtures mirror the real San Antonio export (2026-08-11): a vendor
// file whose "Last Sale Amount" column is modelled fiction and whose
// "MLS Amount"-where-SOLD column is 94.8% transaction-shaped, with a clean
// monotonic condition ladder.

import { describe, it, expect } from "vitest";
import { buildSeedsFromPropstream, type PropstreamRow } from "./propstream-seed";

const NOW = "2026-08-11T00:00:00.000Z";

function row(over: Partial<PropstreamRow> = {}): PropstreamRow {
  return {
    zip: "78210",
    city: "San Antonio",
    state: "TX",
    mlsStatus: "SOLD",
    mlsAmount: 200_000,
    buildingSqft: 1_200,
    totalCondition: "Good",
    ...over,
  };
}

/** Transaction-shaped prices (endings 00/50/90/95/99), as real closings are. */
const REAL = [199_900, 205_000, 212_500, 189_999, 224_000, 198_000, 231_500, 207_900];
/** Model output — arbitrary to the dollar, as the vendor's Last Sale Amount is. */
const FICTION = [201_347, 198_216, 223_884, 190_733, 212_461, 205_128, 229_617, 194_052];

describe("only closed transactions may seed", () => {
  it("ignores PENDING, ACTIVE and EXPIRED — an ask is not a receipt", () => {
    const r = buildSeedsFromPropstream({
      rows: [
        ...REAL.map((p) => row({ mlsAmount: p })),
        ...["PENDING", "ACTIVE", "EXPIRED", "WITHDRAWN"].map((s) =>
          row({ mlsStatus: s, mlsAmount: 900_000 }),
        ),
      ],
      fetchedAt: NOW,
    });
    expect(r.totals.soldRows).toBe(REAL.length);
    expect(r.totals.droppedNotSold).toBe(4);
    // The 900k asks must not have moved the seed.
    expect(r.seeds[0].renovatedPerSqft).toBeLessThan(250);
  });
});

describe("condition bands — ARV is after-repair, so only renovated comps set it", () => {
  it("prices from Good/Excellent and keeps as-is comps as context only", () => {
    const r = buildSeedsFromPropstream({
      rows: [
        // renovated: $200/sqft
        ...REAL.map((p) => row({ mlsAmount: p, buildingSqft: 1_000, totalCondition: "Good" })),
        // as-is: ~$85/sqft — must NOT drag ARV down
        ...REAL.map((p) => row({ mlsAmount: p * 0.42, buildingSqft: 1_000, totalCondition: "Poor" })),
      ],
      fetchedAt: NOW,
    });
    const rep = r.reports[0];
    expect(rep.arvCompCount).toBe(REAL.length);
    expect(rep.asIsCompCount).toBe(REAL.length);
    expect(rep.renovatedPerSqft).toBeGreaterThan(190);
    // The as-is median is retained as context, well below the ARV psf.
    expect(rep.asIsPerSqft).toBeLessThan(rep.renovatedPerSqft as number);
    const receipts = JSON.parse(r.seeds[0].receiptsJson as string);
    expect(receipts.as_is_psf_median).toBeCloseTo(rep.asIsPerSqft as number, 5);
    // Only renovated comps go in the receipts the slope-fitter reads.
    expect(receipts.comps).toHaveLength(REAL.length);
  });

  it("a ZIP with only as-is comps is DONT_PRICE, not a low ARV", () => {
    const r = buildSeedsFromPropstream({
      rows: REAL.map((p) => row({ mlsAmount: p, totalCondition: "Average" })),
      fetchedAt: NOW,
    });
    expect(r.seeds[0].dontPrice).toBe(true);
    expect(r.reports[0].reason).toMatch(/no renovated/i);
    expect(r.reports[0].renovatedPerSqft).toBeNull();
  });

  it("refuses to guess on blank condition — counted usable, priced into neither band", () => {
    const r = buildSeedsFromPropstream({
      rows: REAL.map((p) => row({ mlsAmount: p, totalCondition: "" })),
      fetchedAt: NOW,
    });
    expect(r.totals.usableRows).toBe(REAL.length);
    expect(r.reports[0].arvCompCount).toBe(0);
    expect(r.seeds[0].dontPrice).toBe(true);
  });
});

describe("the fiction gate runs per column, on the ARV band's own prices", () => {
  it("holds a ZIP whose renovated comps are model-shaped", () => {
    const r = buildSeedsFromPropstream({
      rows: FICTION.map((p) => row({ mlsAmount: p })),
      fetchedAt: NOW,
    });
    expect(r.seeds[0].dontPrice).toBe(true);
    expect(r.reports[0].reason).toMatch(/model-shaped/);
    expect(r.reports[0].transactionShare).toBeLessThan(0.5);
  });

  it("passes a ZIP whose renovated comps are transaction-shaped", () => {
    const r = buildSeedsFromPropstream({ rows: REAL.map((p) => row({ mlsAmount: p })), fetchedAt: NOW });
    expect(r.seeds[0].dontPrice).toBeFalsy();
    expect(r.reports[0].transactionShare).toBeGreaterThanOrEqual(0.5);
    expect(r.seeds[0].source).toBe("propstream_mls_sold");
  });

  it("prices a thin ZIP but says plainly it was never shape-tested", () => {
    const r = buildSeedsFromPropstream({
      rows: FICTION.slice(0, 3).map((p) => row({ mlsAmount: p })),
      fetchedAt: NOW,
    });
    // Below the 4-comp floor the shape test is not meaningful, so it must
    // not be applied — but the caller has to be told that.
    expect(r.seeds[0].dontPrice).toBeFalsy();
    expect(r.reports[0].reason).toMatch(/never shape-tested|below the .* floor/i);
  });
});

describe("junk rails strip transfers and unit errors without imposing a market view", () => {
  it("drops a portfolio transfer without touching the seed", () => {
    const r = buildSeedsFromPropstream({
      rows: [...REAL.map((p) => row({ mlsAmount: p })), row({ mlsAmount: 546_310_000 })],
      fetchedAt: NOW,
    });
    expect(r.totals.droppedOutOfRails).toBe(1);
    expect(r.reports[0].arvCompCount).toBe(REAL.length);
  });

  it("drops the $3,459/sqft fiction shape that poisoned 78211", () => {
    const r = buildSeedsFromPropstream({
      rows: [row({ mlsAmount: 3_459 * 1_200, buildingSqft: 1_200 })],
      fetchedAt: NOW,
    });
    expect(r.totals.droppedOutOfRails).toBe(1);
  });

  it("keeps an ordinary expensive house — the rails are junk rails, not price opinions", () => {
    const r = buildSeedsFromPropstream({
      rows: REAL.map((p) => row({ mlsAmount: p * 3, buildingSqft: 1_000 })),
      fetchedAt: NOW,
    });
    expect(r.totals.droppedOutOfRails).toBe(0);
    expect(r.seeds[0].dontPrice).toBeFalsy();
  });
});

describe("seed shape", () => {
  it("carries a conservative low end at or below the median", () => {
    const r = buildSeedsFromPropstream({ rows: REAL.map((p) => row({ mlsAmount: p })), fetchedAt: NOW });
    const s = r.seeds[0];
    expect(s.arvLowPerSqft).toBeLessThanOrEqual(s.renovatedPerSqft as number);
  });

  it("writes receipts the measured-slope ladder can fit", () => {
    const r = buildSeedsFromPropstream({
      rows: REAL.map((p, i) => row({ mlsAmount: p, buildingSqft: 900 + i * 100 })),
      fetchedAt: NOW,
    });
    const receipts = JSON.parse(r.seeds[0].receiptsJson as string);
    expect(receipts.comps.length).toBe(REAL.length);
    for (const c of receipts.comps) {
      expect(c.price).toBeGreaterThan(0);
      expect(c.sqft).toBeGreaterThan(0);
    }
    expect(receipts.price_column).toBe("mls_amount_sold");
  });

  it("separates ZIPs and stamps state", () => {
    const r = buildSeedsFromPropstream({
      rows: [
        ...REAL.map((p) => row({ mlsAmount: p, zip: "78210" })),
        ...REAL.map((p) => row({ mlsAmount: p, zip: "78207" })),
      ],
      market: "san_antonio_tx",
      fetchedAt: NOW,
    });
    expect(r.seeds.map((s) => s.zip)).toEqual(["78207", "78210"]);
    expect(r.seeds.every((s) => s.state === "TX" && s.market === "san_antonio_tx")).toBe(true);
  });
});
