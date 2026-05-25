// INV-029 Pre-EMD Gate check tests.

import { describe, it, expect } from "vitest";
import { PRE_EMD_CHECKS, PRE_EMD_CONFIG, PRE_EMD_GATE } from "./pre-emd-checks";
import type { GateContext, PropertyIntelSnapshot } from "./types";
import type { Listing } from "@/lib/types";
import type { RentCastSaleComp } from "@/lib/rentcast";

const NOW = Date.now();
const freshIso = new Date(NOW - 1 * 86_400_000).toISOString(); // 1d ago
const staleIso = new Date(NOW - 10 * 86_400_000).toISOString(); // 10d ago

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: "rec1HTUqK0YEVb7uA",
    address: "23 Fields Ave",
    city: "Memphis",
    state: "TN",
    zip: "38109",
    buildingSqFt: 936,
    arvValidatedAt: freshIso,
    investorMao: 45000,
    rehabEstimatedAt: freshIso,
    rehabSource: "vision",
    memphisAssignmentVerified: true,
    emdOperatorSignoff: true,
    ...over,
  } as unknown as Listing;
}

function pi(over: Partial<PropertyIntelSnapshot> = {}): PropertyIntelSnapshot {
  return {
    buyerMedianValue: 75000,
    discrepancySeverityMax: "none",
    hydrationStatus: "complete",
    lastHydratedAt: freshIso,
    ...over,
  };
}

function comps(sqfts: number[]): RentCastSaleComp[] {
  return sqfts.map((s) => ({
    price: 90000,
    squareFootage: s,
    bedrooms: 3,
    bathrooms: 1,
    yearBuilt: 1960,
    distance: 0.3,
    daysOnMarket: 20,
    removedDate: null,
    saleDate: "2026-04-01",
  }));
}

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    recordId: "rec1HTUqK0YEVb7uA",
    listing: listing(),
    cma: comps([900, 950, 1000]),
    propertyIntel: pi(),
    ...over,
  };
}

const run = (id: string, c: GateContext) => PRE_EMD_CHECKS[id](c, PRE_EMD_CONFIG as unknown as Record<string, unknown>);

describe("PRE_EMD_GATE wiring", () => {
  it("declares 7 blocking items", () => {
    expect(PRE_EMD_GATE.items).toHaveLength(7);
    expect(PRE_EMD_GATE.items.every((i) => i.blocking)).toBe(true);
    expect(PRE_EMD_GATE.id).toBe("pre_emd");
  });
  it("has a check fn for every item", () => {
    for (const item of PRE_EMD_GATE.items) {
      expect(typeof PRE_EMD_CHECKS[item.id]).toBe("function");
    }
  });
});

describe("PE-01 CMA fresh", () => {
  it("passes when arvValidatedAt fresh + comps present", () => {
    expect(run("PE-01", ctx()).status).toBe("pass");
  });
  it("fails when arvValidatedAt missing (CMA absent)", () => {
    expect(run("PE-01", ctx({ listing: listing({ arvValidatedAt: null }) })).status).toBe("fail");
  });
  it("fails when arvValidatedAt stale (>7d)", () => {
    const r = run("PE-01", ctx({ listing: listing({ arvValidatedAt: staleIso }) }));
    expect(r.status).toBe("fail");
    expect(r.reasoning).toMatch(/stale/i);
  });
  it("fails when CMA returns 0 comps", () => {
    expect(run("PE-01", ctx({ cma: [] })).status).toBe("fail");
  });
  it("data_missing when CMA fetch failed (null)", () => {
    expect(run("PE-01", ctx({ cma: null })).status).toBe("data_missing");
  });
});

describe("PE-02 Buyer_Median", () => {
  it("passes when buyer_median positive", () => {
    expect(run("PE-02", ctx()).status).toBe("pass");
  });
  it("fails when no Property_Intel row", () => {
    expect(run("PE-02", ctx({ propertyIntel: null })).status).toBe("fail");
  });
  it("fails when buyer_median null", () => {
    expect(run("PE-02", ctx({ propertyIntel: pi({ buyerMedianValue: null }) })).status).toBe("fail");
  });
  it("fails when buyer_median ≤0", () => {
    expect(run("PE-02", ctx({ propertyIntel: pi({ buyerMedianValue: 0 }) })).status).toBe("fail");
  });
});

describe("PE-03 federation green", () => {
  it("passes on none", () => {
    expect(run("PE-03", ctx({ propertyIntel: pi({ discrepancySeverityMax: "none" }) })).status).toBe("pass");
  });
  it("passes on info", () => {
    expect(run("PE-03", ctx({ propertyIntel: pi({ discrepancySeverityMax: "info" }) })).status).toBe("pass");
  });
  it("fails on amber", () => {
    expect(run("PE-03", ctx({ propertyIntel: pi({ discrepancySeverityMax: "amber" }) })).status).toBe("fail");
  });
  it("fails on red", () => {
    expect(run("PE-03", ctx({ propertyIntel: pi({ discrepancySeverityMax: "red" }) })).status).toBe("fail");
  });
  it("fails when no Property_Intel row", () => {
    expect(run("PE-03", ctx({ propertyIntel: null })).status).toBe("fail");
  });
  it("fails when severity unset", () => {
    expect(run("PE-03", ctx({ propertyIntel: pi({ discrepancySeverityMax: null }) })).status).toBe("fail");
  });
});

describe("PE-04 Memphis assignment", () => {
  it("passes (N/A) for non-TN", () => {
    expect(run("PE-04", ctx({ listing: listing({ state: "TX", memphisAssignmentVerified: false }) })).status).toBe("pass");
  });
  it("fails when TN + not verified", () => {
    expect(run("PE-04", ctx({ listing: listing({ state: "TN", memphisAssignmentVerified: false }) })).status).toBe("fail");
  });
  it("passes when TN + verified", () => {
    expect(run("PE-04", ctx({ listing: listing({ state: "TN", memphisAssignmentVerified: true }) })).status).toBe("pass");
  });
  it("data_missing when state unset", () => {
    expect(run("PE-04", ctx({ listing: listing({ state: null }) })).status).toBe("data_missing");
  });
  it("recognizes 'Tennessee' long form", () => {
    expect(run("PE-04", ctx({ listing: listing({ state: "Tennessee", memphisAssignmentVerified: false }) })).status).toBe("fail");
  });
});

describe("PE-05 buyer-track MAO", () => {
  it("passes when investorMao positive", () => {
    expect(run("PE-05", ctx()).status).toBe("pass");
  });
  it("fails when investorMao null", () => {
    expect(run("PE-05", ctx({ listing: listing({ investorMao: null }) })).status).toBe("fail");
  });
  it("fails when investorMao ≤0", () => {
    expect(run("PE-05", ctx({ listing: listing({ investorMao: 0 }) })).status).toBe("fail");
  });
});

describe("PE-06 photos vs modeled condition (Sturtevant)", () => {
  it("passes when rehab on record + variance within 50%", () => {
    expect(run("PE-06", ctx()).status).toBe("pass");
  });
  it("fails when no rehab on record (photos never verified)", () => {
    expect(run("PE-06", ctx({ listing: listing({ rehabEstimatedAt: null }) })).status).toBe("fail");
  });
  it("fails when footprint variance >50%", () => {
    // listing 936 vs CMA median 2000 = ~53% variance
    const r = run("PE-06", ctx({ cma: comps([1900, 2000, 2100]) }));
    expect(r.status).toBe("fail");
    expect(r.reasoning).toMatch(/variance/i);
  });
  it("data_missing when buildingSqFt unset", () => {
    expect(run("PE-06", ctx({ listing: listing({ buildingSqFt: null }) })).status).toBe("data_missing");
  });
  it("data_missing when no comp sqfts", () => {
    expect(run("PE-06", ctx({ cma: [] })).status).toBe("data_missing");
  });
});

describe("PE-07 operator sign-off", () => {
  it("passes when signoff true", () => {
    expect(run("PE-07", ctx()).status).toBe("pass");
  });
  it("fails when signoff false", () => {
    expect(run("PE-07", ctx({ listing: listing({ emdOperatorSignoff: false }) })).status).toBe("fail");
  });
  it("fails when signoff undefined", () => {
    expect(run("PE-07", ctx({ listing: listing({ emdOperatorSignoff: undefined }) })).status).toBe("fail");
  });
});

describe("happy path — all 7 pass (gate would be GREEN)", () => {
  it("every check passes on a fully-ready record", () => {
    const c = ctx();
    const statuses = PRE_EMD_GATE.items.map((i) => run(i.id, c).status);
    expect(statuses.every((s) => s === "pass")).toBe(true);
  });
});
