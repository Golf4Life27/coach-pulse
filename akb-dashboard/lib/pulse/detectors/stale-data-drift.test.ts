// Phase 14 / O.4 — stale-data-drift detector tests.

import { describe, it, expect } from "vitest";
import {
  detectStaleDataDrift,
  findStaleListings,
  mostRecentTouchMs,
} from "./stale-data-drift";
import type { Listing } from "@/lib/types";

const NOW = new Date("2026-05-18T20:00:00Z");

function listing(
  id: string,
  daysAgoInbound: number | null,
  daysAgoOutbound: number | null,
  over: Partial<
    Pick<Listing, "lastOutreachDate" | "lastEmailOutreachDate" | "envelopeId">
  > = {},
): Pick<
  Listing,
  | "id"
  | "address"
  | "lastInboundAt"
  | "lastOutboundAt"
  | "lastOutreachDate"
  | "lastEmailOutreachDate"
  | "envelopeId"
> {
  return {
    id,
    address: `${id} Test Ln`,
    lastInboundAt:
      daysAgoInbound != null
        ? new Date(NOW.getTime() - daysAgoInbound * 86_400_000).toISOString()
        : null,
    lastOutboundAt:
      daysAgoOutbound != null
        ? new Date(NOW.getTime() - daysAgoOutbound * 86_400_000).toISOString()
        : null,
    lastOutreachDate: over.lastOutreachDate ?? null,
    lastEmailOutreachDate: over.lastEmailOutreachDate ?? null,
    envelopeId: over.envelopeId ?? null,
  };
}

describe("mostRecentTouchMs", () => {
  it("returns the newer of inbound/outbound timestamps", () => {
    const l = listing("a", 10, 3);
    const t = mostRecentTouchMs(l);
    expect(t).not.toBeNull();
    // outbound 3d ago > inbound 10d ago
    expect(NOW.getTime() - (t ?? 0)).toBeCloseTo(3 * 86_400_000, -3);
  });

  it("returns null when both timestamps are null", () => {
    expect(mostRecentTouchMs(listing("x", null, null))).toBeNull();
  });

  it("works with only one timestamp present", () => {
    const t = mostRecentTouchMs(listing("a", 5, null));
    expect(t).not.toBeNull();
    expect(NOW.getTime() - (t ?? 0)).toBeCloseTo(5 * 86_400_000, -3);
  });
});

describe("findStaleListings", () => {
  it("includes listings older than the threshold", () => {
    const out = findStaleListings(
      [
        listing("a", 20, 18) as Listing,
        listing("b", 5, 3) as Listing,
        listing("c", 30, null) as Listing,
      ],
      14,
      NOW,
    );
    expect(out.map((s) => s.id).sort()).toEqual(["a", "c"]);
  });

  it("sorts oldest-first", () => {
    const out = findStaleListings(
      [
        listing("recent", 16, null) as Listing,
        listing("ancient", 60, null) as Listing,
        listing("middle", 30, null) as Listing,
      ],
      14,
      NOW,
    );
    expect(out.map((s) => s.id)).toEqual(["ancient", "middle", "recent"]);
  });

  it("excludes listings without any touch timestamp", () => {
    const out = findStaleListings([listing("a", null, null) as Listing], 14, NOW);
    expect(out).toEqual([]);
  });
});

const baseInput = {
  audit_log: [],
  listings: [] as Listing[],
  test_count: null,
  previous_test_count: null,
  env: {},
  now: () => NOW,
};

describe("detectStaleDataDrift", () => {
  it("doesn't fire when stale count below warning threshold", () => {
    const listings = Array.from({ length: 4 }, (_, i) =>
      listing(`stale-${i}`, 20, null),
    ) as Listing[];
    expect(detectStaleDataDrift({ ...baseInput, listings })).toEqual([]);
  });

  it("fires warning when ≥5 stale listings", () => {
    const listings = Array.from({ length: 6 }, (_, i) =>
      listing(`stale-${i}`, 20, null),
    ) as Listing[];
    const dets = detectStaleDataDrift({ ...baseInput, listings });
    expect(dets[0].severity).toBe("warning");
    expect(dets[0].detector_id).toBe("stale_data_drift");
  });

  it("fires critical when ≥20 stale listings (33-response-cluster class)", () => {
    const listings = Array.from({ length: 25 }, (_, i) =>
      listing(`stale-${i}`, 20, null),
    ) as Listing[];
    const dets = detectStaleDataDrift({ ...baseInput, listings });
    expect(dets[0].severity).toBe("critical");
  });

  it("recent activity (< staleDays) excluded from count", () => {
    const listings = Array.from({ length: 10 }, (_, i) =>
      listing(`recent-${i}`, 5, 3),
    ) as Listing[];
    expect(detectStaleDataDrift({ ...baseInput, listings })).toEqual([]);
  });

  it("env-overridable staleDays + thresholds", () => {
    const listings = Array.from({ length: 2 }, (_, i) =>
      listing(`stale-${i}`, 10, null),
    ) as Listing[];
    const dets = detectStaleDataDrift({
      ...baseInput,
      listings,
      env: {
        PULSE_STALE_DRIFT_DAYS: "7",
        PULSE_STALE_DRIFT_WARNING_COUNT: "1",
      },
    });
    expect(dets[0].severity).toBe("warning");
  });

  it("source_data includes the oldest sample for triage", () => {
    const listings = Array.from({ length: 6 }, (_, i) =>
      listing(`L${i}`, 20 + i, null),
    ) as Listing[];
    const dets = detectStaleDataDrift({ ...baseInput, listings });
    const sample = dets[0].source_data?.oldest_sample as Array<{ id: string }>;
    expect(sample).toBeDefined();
    expect(sample[0].id).toBe("L5"); // 25d, oldest
  });
});

describe("stale-data-drift — Phase 11.4 INV-004 parity fixes", () => {
  it("excludes envelopeId-populated records from stale aggregate (contract-state guard)", () => {
    // 6 stale records but 2 have envelopeId set → only 4 counted → below warning (5)
    const listings = [
      ...Array.from({ length: 4 }, (_, i) => listing(`stale-${i}`, 20, null)),
      listing("contract-1", 20, null, { envelopeId: "env-1" }),
      listing("contract-2", 20, null, { envelopeId: "env-2" }),
    ] as Listing[];
    expect(detectStaleDataDrift({ ...baseInput, listings })).toEqual([]);
  });

  it("considers lastEmailOutreachDate when computing record staleness (Phase 11.2 parity)", () => {
    // Pre-fix: only lastInbound + lastOutbound were considered. Now lastEmail and
    // lastOutreachDate also count toward freshness. Record with stale 4-field max
    // counts as stale; record with fresh email but stale inbound/outbound counts
    // as FRESH (not stale).
    const listings = [
      // Stale on inbound/outbound but FRESH via email — should NOT be flagged
      listing(`fresh-email`, 30, 30, {
        lastEmailOutreachDate: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
      }),
      // Stale on every field — should be flagged
      listing(`truly-stale`, 30, 30, {
        lastOutreachDate: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
        lastEmailOutreachDate: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
      }),
    ] as Listing[];
    const stale = findStaleListings(listings, 14, NOW);
    expect(stale.map((s) => s.id)).toEqual(["truly-stale"]);
  });
});
