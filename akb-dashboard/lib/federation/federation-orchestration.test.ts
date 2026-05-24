// INV-022 Sprint 3 — orchestration pure helper tests (partial-failure core).

import { describe, it, expect } from "vitest";
import {
  summarizeHydrationStatus,
  memphisAssignmentApplies,
  hydrateRecord,
  type VendorOutcomes,
  type HydrateRecordInput,
  type HydrateRecordDeps,
} from "./federation-orchestration";
import type { RentcastHydrateResult } from "./rentcast-hydrate";
import type { PhotoContribution } from "./property-intel-store";

const NOW = new Date("2026-05-25T16:00:00.000Z");

function baseInput(over: Partial<HydrateRecordInput> = {}): HydrateRecordInput {
  return {
    address: "23 Fields Ave",
    city: "Memphis",
    state: "TN",
    zip: "38109",
    buildingSqFt: 936,
    verificationUrl: "https://www.redfin.com/TN/Memphis/23-Fields-Ave-38109/home/87658196",
    contractOfferPrice: 61750,
    existingFloodZone: null,
    rentcastBudgetRemaining: 40,
    ...over,
  };
}

function okValuation(): RentcastHydrateResult {
  return {
    valuation: {
      asIsValue: 95000,
      asIsValueLow: 85000,
      asIsValueHigh: 105000,
      source: "rentcast",
      fetchedAt: NOW.toISOString(),
    },
    rent: { rent: 1200, source: "rentcast", fetchedAt: NOW.toISOString() },
    comps: { comps: [{ price: 90000 }], source: "rentcast" },
    errors: [],
    creditsSpent: 2,
  };
}

function okPhotos(): PhotoContribution {
  return {
    photos: [{ url: "https://x/1.jpg", source: "listing" }],
    source: "scraperapi",
    fetchedAt: NOW.toISOString(),
  };
}

function deps(over: Partial<HydrateRecordDeps> = {}): HydrateRecordDeps {
  return {
    hydrateValuation: async () => okValuation(),
    hydratePhotos: async () => okPhotos(),
    getFloodZoneByAddress: async () => "X",
    ...over,
  };
}

function o(over: Partial<VendorOutcomes> = {}): VendorOutcomes {
  return { rentcast: "ok", photos: "ok", flood: "ok", ...over };
}

describe("summarizeHydrationStatus — partial-failure isolation", () => {
  it("all ok → complete", () => {
    expect(summarizeHydrationStatus(o())).toBe("complete");
  });

  it("rentcast fails, others ok → partial (isolation: FEMA/photos still counted)", () => {
    expect(summarizeHydrationStatus(o({ rentcast: "failed" }))).toBe("partial");
  });

  it("photos fail, others ok → partial", () => {
    expect(summarizeHydrationStatus(o({ photos: "failed" }))).toBe("partial");
  });

  it("flood fails, others ok → partial", () => {
    expect(summarizeHydrationStatus(o({ flood: "failed" }))).toBe("partial");
  });

  it("all attempted vendors fail → failed", () => {
    expect(
      summarizeHydrationStatus({ rentcast: "failed", photos: "failed", flood: "failed" }),
    ).toBe("failed");
  });

  it("rentcast skipped for budget but photos+flood ok → partial", () => {
    expect(summarizeHydrationStatus(o({ rentcast: "skipped_budget" }))).toBe("partial");
  });

  it("rentcast skipped for budget, others also failed → failed (zero ok)", () => {
    expect(
      summarizeHydrationStatus({
        rentcast: "skipped_budget",
        photos: "failed",
        flood: "failed",
      }),
    ).toBe("failed");
  });

  it("flood skipped via cache (neutral) + others ok → complete", () => {
    expect(summarizeHydrationStatus(o({ flood: "skipped_cache" }))).toBe("complete");
  });

  it("flood cached + rentcast ok + photos failed → partial", () => {
    expect(
      summarizeHydrationStatus({ rentcast: "ok", photos: "failed", flood: "skipped_cache" }),
    ).toBe("partial");
  });

  it("everything cached/neutral (nothing to attempt) → complete", () => {
    expect(
      summarizeHydrationStatus({
        rentcast: "skipped_cache",
        photos: "skipped_cache",
        flood: "skipped_cache",
      }),
    ).toBe("complete");
  });

  it("flood cached + rentcast ok + photos ok → complete (cache is neutral)", () => {
    expect(
      summarizeHydrationStatus({ rentcast: "ok", photos: "ok", flood: "skipped_cache" }),
    ).toBe("complete");
  });
});

describe("memphisAssignmentApplies", () => {
  it("TN + Memphis → true", () => {
    expect(memphisAssignmentApplies("TN", "Memphis")).toBe(true);
    expect(memphisAssignmentApplies("tn", "memphis")).toBe(true);
    expect(memphisAssignmentApplies("TN", "East Memphis")).toBe(true);
  });
  it("TN + non-Memphis city → false", () => {
    expect(memphisAssignmentApplies("TN", "Nashville")).toBe(false);
  });
  it("non-TN + Memphis → false (no other state has the clause discipline here)", () => {
    expect(memphisAssignmentApplies("TX", "Memphis")).toBe(false);
  });
  it("null inputs → false", () => {
    expect(memphisAssignmentApplies(null, "Memphis")).toBe(false);
    expect(memphisAssignmentApplies("TN", null)).toBe(false);
  });
});

describe("hydrateRecord — end-to-end partial-failure isolation", () => {
  it("all vendors ok → complete, all contributions present", async () => {
    const r = await hydrateRecord(baseInput(), deps(), NOW);
    expect(r.status).toBe("complete");
    expect(r.outcomes).toEqual({ rentcast: "ok", photos: "ok", flood: "ok" });
    expect(r.contribution.valuation?.asIsValue).toBe(95000);
    expect(r.contribution.rent?.rent).toBe(1200);
    expect(r.contribution.photos?.photos).toHaveLength(1);
    expect(r.contribution.flood?.zone).toBe("X");
    expect(r.creditsSpent).toBe(2);
  });

  // THE required test: one vendor fails, others still persist, status=partial.
  it("RentCast throws → partial; photos + flood STILL persist (isolation)", async () => {
    const r = await hydrateRecord(
      baseInput(),
      deps({
        hydrateValuation: async () => {
          throw new Error("RentCast 500: upstream down");
        },
      }),
      NOW,
    );
    expect(r.status).toBe("partial");
    expect(r.outcomes.rentcast).toBe("failed");
    expect(r.outcomes.photos).toBe("ok");
    expect(r.outcomes.flood).toBe("ok");
    // RentCast produced nothing...
    expect(r.contribution.valuation).toBeUndefined();
    expect(r.contribution.rent).toBeUndefined();
    // ...but the other two vendors' data is intact.
    expect(r.contribution.photos?.photos).toHaveLength(1);
    expect(r.contribution.flood?.zone).toBe("X");
    expect(r.creditsSpent).toBe(0); // nothing spent when the call threw
  });

  it("photos throw → partial; rentcast + flood persist", async () => {
    const r = await hydrateRecord(
      baseInput(),
      deps({
        hydratePhotos: async () => {
          throw new Error("ScraperAPI timeout");
        },
      }),
      NOW,
    );
    expect(r.status).toBe("partial");
    expect(r.contribution.valuation?.asIsValue).toBe(95000);
    expect(r.contribution.flood?.zone).toBe("X");
    expect(r.contribution.photos).toBeUndefined();
  });

  it("flood throws → partial; rentcast + photos persist", async () => {
    const r = await hydrateRecord(
      baseInput(),
      deps({
        getFloodZoneByAddress: async () => {
          throw new Error("NFHL 503");
        },
      }),
      NOW,
    );
    expect(r.status).toBe("partial");
    expect(r.outcomes.flood).toBe("failed");
    expect(r.contribution.valuation?.asIsValue).toBe(95000);
    expect(r.contribution.photos?.photos).toHaveLength(1);
  });

  it("all three vendors fail → failed, nothing persisted", async () => {
    const r = await hydrateRecord(
      baseInput(),
      {
        hydrateValuation: async () => {
          throw new Error("x");
        },
        hydratePhotos: async () => {
          throw new Error("y");
        },
        getFloodZoneByAddress: async () => {
          throw new Error("z");
        },
      },
      NOW,
    );
    expect(r.status).toBe("failed");
    expect(r.contribution.valuation).toBeUndefined();
    expect(r.contribution.photos).toBeUndefined();
    expect(r.contribution.flood).toBeUndefined();
  });

  it("flood already cached → skipped_cache, no flood re-pull, complete", async () => {
    let floodCalled = false;
    const r = await hydrateRecord(
      baseInput({ existingFloodZone: "AE" }),
      deps({
        getFloodZoneByAddress: async () => {
          floodCalled = true;
          return "X";
        },
      }),
      NOW,
    );
    expect(floodCalled).toBe(false); // static-per-parcel cache honored
    expect(r.outcomes.flood).toBe("skipped_cache");
    expect(r.status).toBe("complete");
  });

  it("RentCast budget exhausted → skipped_budget, partial; free vendors run", async () => {
    let rcCalled = false;
    const r = await hydrateRecord(
      baseInput({ rentcastBudgetRemaining: 1 }), // < 2 credits/hydration
      deps({
        hydrateValuation: async () => {
          rcCalled = true;
          return okValuation();
        },
      }),
      NOW,
    );
    expect(rcCalled).toBe(false); // budget gate prevented the call
    expect(r.outcomes.rentcast).toBe("skipped_budget");
    expect(r.status).toBe("partial");
    expect(r.contribution.photos?.photos).toHaveLength(1);
  });

  it("missing address parts → all vendors failed", async () => {
    const r = await hydrateRecord(
      baseInput({ zip: null }),
      deps(),
      NOW,
    );
    expect(r.status).toBe("failed");
    expect(r.outcomes).toEqual({ rentcast: "failed", photos: "failed", flood: "failed" });
  });

  it("surfaces price-drift + Memphis discrepancies (23 Fields shape)", async () => {
    // AS-IS 95k vs contract 61.75k = ~54% drift; TN/Memphis assignment.
    const r = await hydrateRecord(baseInput(), deps(), NOW);
    const types = r.contribution.discrepancy?.flags.map((f) => f.type) ?? [];
    expect(types).toContain("price_drift");
    expect(types).toContain("memphis_assignment");
  });

  it("clean photos returning null is ok (no contribution, not a failure)", async () => {
    const r = await hydrateRecord(
      baseInput(),
      deps({ hydratePhotos: async () => null }),
      NOW,
    );
    expect(r.outcomes.photos).toBe("ok");
    expect(r.contribution.photos).toBeUndefined();
    expect(r.status).toBe("complete");
  });
});
