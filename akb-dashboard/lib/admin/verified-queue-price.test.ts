// Verified-queue pricing planner — unit tests. Proves it's buyer-median-driven
// and HOLDs (never fabricates) when no qualifying median exists.

import { describe, it, expect } from "vitest";
import { planVerifiedQueuePricing, summarizeVerifiedPricing } from "./verified-queue-price";
import type { UnderwriteContext } from "@/lib/track-aware-underwrite";
import type { ZipBuyerMedian } from "@/lib/buyer-median-store";
import type { Listing } from "@/lib/types";

function median(zip: string, track: "landlord" | "flipper", value: number, compCount = 40): ZipBuyerMedian {
  return { zip, track, value, source: "investorbase_manual", compCount } as unknown as ZipBuyerMedian;
}

function ctxWith(medians: ZipBuyerMedian[]): UnderwriteContext {
  const zipMedians = new Map<string, ZipBuyerMedian>();
  for (const m of medians) zipMedians.set(`${m.zip}:${m.track}`, m);
  return { zipMedians, errors: new Map() };
}

function lst(over: Partial<Listing>): Listing {
  return { id: "rec1", address: "1 Test St", state: "MI", zip: "48227", ...over } as unknown as Listing;
}

// Medians for BOTH tracks so the assertion is robust to cohort-track resolution.
const bothTracks = [median("48227", "landlord", 55000), median("48227", "flipper", 60000)];

describe("planVerifiedQueuePricing", () => {
  it("prices a verified record off a qualifying buyer median", () => {
    // distressed → landlord cohort → prices off the as-is median (no rehab needed).
    const rows = planVerifiedQueuePricing([lst({ id: "recA", zip: "48227", distressScore: 1 })], ctxWith(bothTracks));
    expect(rows[0].decision).toBe("price");
    expect(rows[0].track).toBe("landlord");
    expect(rows[0].investorMao).not.toBeNull();
    expect(rows[0].investorMao!).toBeGreaterThan(0);
    expect(rows[0].buyerMedian).not.toBeNull();
  });

  it("HOLDs a record whose ZIP has no median — no fabricated price", () => {
    const rows = planVerifiedQueuePricing([lst({ id: "recB", zip: "99999" })], ctxWith(bothTracks));
    expect(rows[0].decision).toBe("hold");
    expect(rows[0].investorMao).toBeNull();
    expect(rows[0].holdReason).toBeTruthy();
  });

  it("HOLDs an invalid ZIP", () => {
    const rows = planVerifiedQueuePricing([lst({ id: "recC", zip: "" })], ctxWith([]));
    expect(rows[0].decision).toBe("hold");
    expect(rows[0].holdReason).toBe("invalid_zip");
  });

  it("summary counts priceable vs held", () => {
    const rows = planVerifiedQueuePricing(
      [lst({ id: "a", zip: "48227", distressScore: 1 }), lst({ id: "b", zip: "99999" }), lst({ id: "c", zip: "" })],
      ctxWith(bothTracks),
    );
    const s = summarizeVerifiedPricing(rows);
    expect(s.batch).toBe(3);
    expect(s.priceable).toBe(1);
    expect(s.held).toBe(2);
  });
});
