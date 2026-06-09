import { describe, it, expect } from "vitest";
import { selectDailyZipSlice, utcDayIndex, type ZipSliceResult } from "./zip-rotation";

// Synthetic 54-ZIP registry mirroring the 6/8 bug: 24 TX/TN +
// 30 Detroit (sorted, the cron sorts before slicing).
const SIM_REGISTRY = (() => {
  const zips: string[] = [];
  for (let i = 38109; i < 38133; i++) zips.push(String(i)); // 24 Memphis-ish
  for (let i = 48201; i < 48241; i++) zips.push(String(i)); // 40 Detroit-ish
  return zips.slice(0, 54).sort();
})();

describe("selectDailyZipSlice — the 6/8 outage repro", () => {
  it("returns the full list when total <= cap (no rotation)", () => {
    const r = selectDailyZipSlice(SIM_REGISTRY.slice(0, 24), 30, new Date("2026-06-08T03:00:00Z"));
    expect(r.selected).toHaveLength(24);
    expect(r.cycleDays).toBe(1);
    expect(r.wrapped).toBe(false);
  });

  it("never returns more than dailyCap (the quota safety)", () => {
    for (let d = 0; d < 30; d++) {
      const now = new Date(2026, 5, d + 1);
      const r = selectDailyZipSlice(SIM_REGISTRY, 30, now);
      expect(r.selected.length).toBeLessThanOrEqual(30);
    }
  });

  it("sweeps the full registry over ceil(total/cap) days", () => {
    const seen = new Set<string>();
    const r0 = selectDailyZipSlice(SIM_REGISTRY, 30, new Date("2026-06-08T03:00:00Z"));
    r0.selected.forEach((z) => seen.add(z));
    expect(r0.cycleDays).toBe(2);
    // next day
    const r1 = selectDailyZipSlice(SIM_REGISTRY, 30, new Date("2026-06-09T03:00:00Z"));
    r1.selected.forEach((z) => seen.add(z));
    // two days = full sweep
    expect(seen.size).toBe(54);
  });

  it("is deterministic for the same day (idempotent re-fire)", () => {
    const a = selectDailyZipSlice(SIM_REGISTRY, 30, new Date("2026-06-08T03:00:00Z"));
    const b = selectDailyZipSlice(SIM_REGISTRY, 30, new Date("2026-06-08T23:59:00Z"));
    expect(a.selected).toEqual(b.selected);
    expect(a.startIndex).toBe(b.startIndex);
  });

  it("advances exactly one slice per UTC day", () => {
    const a = selectDailyZipSlice(SIM_REGISTRY, 30, new Date("2026-06-08T12:00:00Z"));
    const b = selectDailyZipSlice(SIM_REGISTRY, 30, new Date("2026-06-09T12:00:00Z"));
    expect(b.startIndex).not.toBe(a.startIndex);
    // Day 1 starts after day 0's slice ends, modulo total.
    expect(b.startIndex).toBe((a.startIndex + 30) % 54);
  });

  it("wraps cleanly when the slice straddles end-of-list", () => {
    // 50 ZIPs, cap 30: find a day where the slice straddles end-of-list
    // (a startIndex > 20 forces a wrap), then verify the wrap is correct
    // index-agnostically — startIndex is dayIdx-driven so don't hardcode it.
    const small = SIM_REGISTRY.slice(0, 50);
    let wrappingDay: ZipSliceResult | null = null;
    for (let d = 0; d < 5; d++) {
      const r = selectDailyZipSlice(small, 30, new Date(Date.UTC(2026, 5, 8 + d)));
      if (r.wrapped) {
        wrappingDay = r;
        break;
      }
    }
    expect(wrappingDay).not.toBeNull();
    if (!wrappingDay) return;
    expect(wrappingDay.selected.length).toBe(30);
    expect(wrappingDay.selected[0]).toBe(small[wrappingDay.startIndex]);
    const tailLen = 50 - wrappingDay.startIndex;
    expect(wrappingDay.selected[tailLen]).toBe(small[0]);
  });

  it("breadth tax: each daily slice mixes states when registry is mixed", () => {
    // The pre-6/8 registry was 24 TX/TN; 6/7 added 30 Detroit. With
    // rotation on the sorted list, every slice spans both clusters as
    // it advances — the breadth concern the operator raised is addressed
    // structurally, not by special-casing.
    const fullSorted = SIM_REGISTRY;
    const slices = Array.from({ length: 2 }, (_, d) =>
      selectDailyZipSlice(fullSorted, 30, new Date(2026, 5, 10 + d)),
    );
    // Across the two-day sweep, both TX/TN (3xxxx) and Detroit (4xxxx)
    // ranges appear.
    const allSeen = new Set(slices.flatMap((s) => s.selected));
    const has3 = [...allSeen].some((z) => z.startsWith("3"));
    const has4 = [...allSeen].some((z) => z.startsWith("4"));
    expect(has3).toBe(true);
    expect(has4).toBe(true);
  });

  it("empty input returns empty, no throw", () => {
    expect(selectDailyZipSlice([], 30, new Date()).selected).toEqual([]);
  });

  it("dailyCap <= 0 returns empty (defensive)", () => {
    expect(selectDailyZipSlice(SIM_REGISTRY, 0, new Date()).selected).toEqual([]);
    expect(selectDailyZipSlice(SIM_REGISTRY, -5, new Date()).selected).toEqual([]);
  });
});

describe("utcDayIndex", () => {
  it("advances by exactly 1 across UTC midnight", () => {
    const a = utcDayIndex(new Date("2026-06-08T23:59:59Z"));
    const b = utcDayIndex(new Date("2026-06-09T00:00:00Z"));
    expect(b - a).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// selectDueZips — freshness cursor (2026-06-08 timeout fix).
// ─────────────────────────────────────────────────────────────────────

import { selectDueZips, type ZipDueRow } from "./zip-rotation";

const NOW = new Date("2026-06-08T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("selectDueZips — freshness cursor", () => {
  it("treats never-ingested (null) ZIPs as the stalest — picked first", () => {
    const rows: ZipDueRow[] = [
      { zip: "48201", lastIngestedAt: null },
      { zip: "78210", lastIngestedAt: hoursAgo(48) },
    ];
    const r = selectDueZips(rows, 5, NOW, 24);
    expect(r.selected[0]).toBe("48201"); // null is oldest
    expect(r.dueTotal).toBe(2);
  });

  it("excludes ZIPs freshened within the cycle window (never re-dig)", () => {
    const rows: ZipDueRow[] = [
      { zip: "48201", lastIngestedAt: hoursAgo(2) }, // fresh
      { zip: "78210", lastIngestedAt: hoursAgo(30) }, // due
    ];
    const r = selectDueZips(rows, 5, NOW, 24);
    expect(r.selected).toEqual(["78210"]);
    expect(r.freshTotal).toBe(1);
    expect(r.dueTotal).toBe(1);
  });

  it("caps the per-invocation set (the timeout fix — small runs)", () => {
    const rows: ZipDueRow[] = Array.from({ length: 54 }, (_, i) => ({
      zip: String(48200 + i),
      lastIngestedAt: null,
    }));
    const r = selectDueZips(rows, 6, NOW, 24);
    expect(r.selected).toHaveLength(6);
    expect(r.dueTotal).toBe(54);
    expect(r.runsToClearBacklog).toBe(9); // ceil(54/6)
  });

  it("advances across invocations as ZIPs get freshened", () => {
    // Run 1: 54 stale, cap 6 → picks first 6.
    const rows: ZipDueRow[] = Array.from({ length: 54 }, (_, i) => ({
      zip: String(48200 + i),
      lastIngestedAt: null,
    }));
    const run1 = selectDueZips(rows, 6, NOW, 24);
    // Simulate freshening those 6.
    const freshenedZips = new Set(run1.selected);
    const after = rows.map((r) =>
      freshenedZips.has(r.zip) ? { ...r, lastIngestedAt: NOW.toISOString() } : r,
    );
    const run2 = selectDueZips(after, 6, NOW, 24);
    // Run 2 picks a DIFFERENT 6 (the next stalest) — no overlap.
    expect(run2.selected.some((z) => freshenedZips.has(z))).toBe(false);
    expect(run2.dueTotal).toBe(48);
  });

  it("no-ops when everything is fresh (cycle complete)", () => {
    const rows: ZipDueRow[] = Array.from({ length: 10 }, (_, i) => ({
      zip: String(48200 + i),
      lastIngestedAt: hoursAgo(1),
    }));
    const r = selectDueZips(rows, 6, NOW, 24);
    expect(r.selected).toEqual([]);
    expect(r.dueTotal).toBe(0);
    expect(r.freshTotal).toBe(10);
  });

  it("is idempotent within a cycle (same now + rows → same selection)", () => {
    const rows: ZipDueRow[] = [
      { zip: "48201", lastIngestedAt: hoursAgo(40) },
      { zip: "48202", lastIngestedAt: hoursAgo(50) },
      { zip: "48203", lastIngestedAt: null },
    ];
    const a = selectDueZips(rows, 2, NOW, 24);
    const b = selectDueZips(rows, 2, NOW, 24);
    expect(a.selected).toEqual(b.selected);
    // Stalest-first: null (48203), then 50h (48202).
    expect(a.selected).toEqual(["48203", "48202"]);
  });

  it("partial-safe: an un-freshened (errored) ZIP stays due next run", () => {
    const rows: ZipDueRow[] = [
      { zip: "48201", lastIngestedAt: null },
      { zip: "48202", lastIngestedAt: null },
    ];
    const run1 = selectDueZips(rows, 2, NOW, 24);
    // Simulate ONLY 48201 freshened (48202 errored mid-run).
    const after = rows.map((r) =>
      r.zip === "48201" ? { ...r, lastIngestedAt: NOW.toISOString() } : r,
    );
    const run2 = selectDueZips(after, 2, NOW, 24);
    expect(run2.selected).toEqual(["48202"]); // errored ZIP still due
  });

  it("cap <= 0 returns empty (defensive)", () => {
    const rows: ZipDueRow[] = [{ zip: "48201", lastIngestedAt: null }];
    expect(selectDueZips(rows, 0, NOW, 24).selected).toEqual([]);
  });

  it("skips malformed ZIPs", () => {
    const rows: ZipDueRow[] = [
      { zip: "bad", lastIngestedAt: null },
      { zip: "48201", lastIngestedAt: null },
    ];
    const r = selectDueZips(rows, 5, NOW, 24);
    expect(r.selected).toEqual(["48201"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 402-stay-due guarantee (operator 2026-06-08): a ZIP whose verify phase
// was blocked (Firecrawl 402) is NOT stamped, so its lastIngestedAt stays
// null/stale → it remains DUE next run. This is the cron's contract that
// selectDueZips upholds; pinned here at the selector level.
// ─────────────────────────────────────────────────────────────────────

describe("selectDueZips — 402-blocked ZIP stays due", () => {
  it("a never-stamped (402-blocked) ZIP is picked again next run while a successful one is skipped", () => {
    // Run 1: both null (due). Cron 402s ZIP A (not stamped) but succeeds on
    // ZIP B (stamped now).
    const afterRun1: ZipDueRow[] = [
      { zip: "48201", lastIngestedAt: null }, // A: 402-blocked, stayed null
      { zip: "48202", lastIngestedAt: NOW.toISOString() }, // B: succeeded, stamped
    ];
    const run2 = selectDueZips(afterRun1, 6, NOW, 24);
    // Only the blocked ZIP is due; the successful one is fresh.
    expect(run2.selected).toEqual(["48201"]);
    expect(run2.freshTotal).toBe(1);
  });

  it("once credits refill and the ZIP finally stamps, it goes fresh (cron stops retrying)", () => {
    const afterRefill: ZipDueRow[] = [
      { zip: "48201", lastIngestedAt: NOW.toISOString() }, // finally ingested
    ];
    const r = selectDueZips(afterRefill, 6, NOW, 24);
    expect(r.selected).toEqual([]);
    expect(r.dueTotal).toBe(0);
  });
});
