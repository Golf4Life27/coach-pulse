// quo-reconcile backstop starvation fix (2026-07-27) — 50 audited runs
// showed phones_scanned:40, updates:0 on a 76-79-phone pool because the
// unsorted, un-rotated 40-phone prefix never advanced. These tests prove
// (1) freshest-activity-first ordering and (2) full pool coverage over
// successive runs with the cap respected, composed with the same rotating
// cursor scan-comms' sibling fix (rehab-sweep-cursor.ts) already proves
// in isolation.

import { describe, it, expect, beforeEach } from "vitest";
import { sortPhonesByFreshness, type PhoneActivityListing } from "./quo-phone-rotation";
import { nextRehabSweepSlice, _resetMemoryRing } from "./admin/rehab-sweep-cursor";

beforeEach(() => {
  _resetMemoryRing();
});

function pool(n: number): Map<string, PhoneActivityListing[]> {
  const m = new Map<string, PhoneActivityListing[]>();
  for (let i = 0; i < n; i++) {
    m.set(`+1555${String(i).padStart(7, "0")}`, [{ lastInboundAt: null, lastOutboundAt: null }]);
  }
  return m;
}

describe("sortPhonesByFreshness — pure ordering", () => {
  it("freshest activity (max of inbound/outbound) sorts first", () => {
    const m = new Map<string, PhoneActivityListing[]>([
      ["+15550000001", [{ lastInboundAt: "2026-07-20T00:00:00Z", lastOutboundAt: null }]],
      ["+15550000002", [{ lastInboundAt: "2026-07-26T00:00:00Z", lastOutboundAt: null }]],
      ["+15550000003", [{ lastInboundAt: null, lastOutboundAt: "2026-07-15T00:00:00Z" }]],
    ]);
    const sorted = sortPhonesByFreshness(m);
    expect(sorted.map((c) => c.id)).toEqual(["+15550000002", "+15550000001", "+15550000003"]);
  });

  it("a phone with no activity (never texted) sorts last", () => {
    const m = new Map<string, PhoneActivityListing[]>([
      ["+15550000001", [{ lastInboundAt: null, lastOutboundAt: null }]],
      ["+15550000002", [{ lastInboundAt: "2026-07-01T00:00:00Z", lastOutboundAt: null }]],
    ]);
    const sorted = sortPhonesByFreshness(m);
    expect(sorted.map((c) => c.id)).toEqual(["+15550000002", "+15550000001"]);
  });

  it("a phone's freshness is the MAX across every listing it's shared with", () => {
    const m = new Map<string, PhoneActivityListing[]>([
      [
        "+15550000001",
        [
          { lastInboundAt: "2026-07-01T00:00:00Z", lastOutboundAt: null },
          { lastInboundAt: "2026-07-25T00:00:00Z", lastOutboundAt: null }, // the fresh one wins
        ],
      ],
      ["+15550000002", [{ lastInboundAt: "2026-07-10T00:00:00Z", lastOutboundAt: null }]],
    ]);
    const sorted = sortPhonesByFreshness(m);
    expect(sorted.map((c) => c.id)).toEqual(["+15550000001", "+15550000002"]);
  });
});

describe("sortPhonesByFreshness + nextRehabSweepSlice — the starvation fix", () => {
  it("the repro: successive runs over a 78-phone pool at cap 40 reach every phone", async () => {
    const candidates = sortPhonesByFreshness(pool(78));
    const seen = new Set<string>();
    let run1Count = 0;
    for (let run = 0; run < 3; run++) {
      const rotation = await nextRehabSweepSlice("quo_reconcile_phones_test", candidates, 40);
      if (run === 0) run1Count = rotation.selected.length;
      rotation.selected.forEach((c) => seen.add(c.id));
    }
    // Cap respected on every run.
    expect(run1Count).toBe(40);
    // Pre-fix behavior: an unsorted, un-rotated slice(0, 40) would leave
    // seen.size === 40 forever (the SAME 40 phones every run). Two runs at
    // cap 40 over a 78-phone pool must cover the full pool.
    expect(seen.size).toBe(78);
  });

  it("a pool at or under the cap never needs more than one run", async () => {
    const candidates = sortPhonesByFreshness(pool(40));
    const rotation = await nextRehabSweepSlice("quo_reconcile_phones_small", candidates, 40);
    expect(rotation.selected.length).toBe(40);
    expect(rotation.wrapped).toBe(false);
  });

  it("KV-unreachable (no cursor persisted) degrades to the sorted prefix, not the unsorted one", async () => {
    // Simulates the in-memory fallback path with no prior cursor: first
    // call always starts at index 0 of the FRESHNESS-SORTED pool.
    const m = new Map<string, PhoneActivityListing[]>([
      ["+15550000001", [{ lastInboundAt: "2026-07-01T00:00:00Z", lastOutboundAt: null }]],
      ["+15550000002", [{ lastInboundAt: "2026-07-26T00:00:00Z", lastOutboundAt: null }]], // freshest
      ["+15550000003", [{ lastInboundAt: "2026-07-10T00:00:00Z", lastOutboundAt: null }]],
    ]);
    const candidates = sortPhonesByFreshness(m);
    const rotation = await nextRehabSweepSlice("quo_reconcile_phones_fresh", candidates, 2);
    expect(rotation.selected.map((c) => c.id)).toEqual(["+15550000002", "+15550000003"]);
  });
});
