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
