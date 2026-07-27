// Rehab-sweep rotating cursor tests — the 96-tick eligible_total:0
// starvation (records deeper in the pool than the top-N were never
// reached because the sweep always sliced from index 0).

import { describe, it, expect, beforeEach } from "vitest";
import {
  selectRotatingSlice,
  nextRehabSweepSlice,
  _resetMemoryRing,
  type CursorCandidate,
  type RotatingSliceResult,
} from "./rehab-sweep-cursor";

beforeEach(() => {
  _resetMemoryRing();
});

function pool(n: number): CursorCandidate[] {
  return Array.from({ length: n }, (_, i) => ({ id: `rec${String(i).padStart(4, "0")}` }));
}

describe("selectRotatingSlice — pure rotation", () => {
  it("no cursor starts at index 0 (today's top-N behavior, unchanged)", () => {
    const r = selectRotatingSlice(pool(10), 3, null);
    expect(r.selected.map((c) => c.id)).toEqual(["rec0000", "rec0001", "rec0002"]);
    expect(r.startIndex).toBe(0);
    expect(r.wrapped).toBe(false);
  });

  it("advances: the next call resumes just past the last cursor", () => {
    const p = pool(10);
    const run1 = selectRotatingSlice(p, 3, null);
    expect(run1.selected.map((c) => c.id)).toEqual(["rec0000", "rec0001", "rec0002"]);
    const run2 = selectRotatingSlice(p, 3, run1.nextCursorId);
    expect(run2.selected.map((c) => c.id)).toEqual(["rec0003", "rec0004", "rec0005"]);
    const run3 = selectRotatingSlice(p, 3, run2.nextCursorId);
    expect(run3.selected.map((c) => c.id)).toEqual(["rec0006", "rec0007", "rec0008"]);
  });

  it("the starvation repro: 96 ticks of limit=3 over a 1,751-record pool reach every record", () => {
    const p = pool(1751);
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let tick = 0; tick < 96; tick++) {
      const r: RotatingSliceResult<CursorCandidate> = selectRotatingSlice(p, 3, cursor);
      r.selected.forEach((c) => seen.add(c.id));
      cursor = r.nextCursorId;
    }
    // 96 ticks * 3/tick = 288 distinct records — the SAME top 3 forever
    // (the pre-fix bug) would leave seen.size === 3.
    expect(seen.size).toBe(288);
    // Records deep in the pool (well past any top-3) are reached.
    expect(seen.has("rec0250")).toBe(true);
  });

  it("wraps past the end of the pool back to the start", () => {
    const p = pool(5);
    const run1 = selectRotatingSlice(p, 3, null); // rec0000..0002
    const run2 = selectRotatingSlice(p, 3, run1.nextCursorId); // rec0003, rec0004, wrap → rec0000
    expect(run2.wrapped).toBe(true);
    expect(run2.selected.map((c) => c.id)).toEqual(["rec0003", "rec0004", "rec0000"]);
  });

  it("a stale cursor (id no longer in the pool) self-heals to index 0", () => {
    const p = pool(10);
    const r = selectRotatingSlice(p, 3, "recGONE");
    expect(r.selected.map((c) => c.id)).toEqual(["rec0000", "rec0001", "rec0002"]);
  });

  it("empty pool or non-positive limit is a safe no-op", () => {
    expect(selectRotatingSlice([], 3, null).selected).toEqual([]);
    expect(selectRotatingSlice(pool(5), 0, null).selected).toEqual([]);
    expect(selectRotatingSlice(pool(5), -1, null).selected).toEqual([]);
  });

  it("total <= limit returns the whole pool (rotation is a no-op when nothing to rotate through)", () => {
    const p = pool(3);
    const r = selectRotatingSlice(p, 5, null);
    expect(r.selected.map((c) => c.id)).toEqual(["rec0000", "rec0001", "rec0002"]);
  });
});

describe("nextRehabSweepSlice — KV-backed persistence (memory fallback in tests)", () => {
  it("persists the cursor across calls without the caller threading it through", async () => {
    const p = pool(10);
    const run1 = await nextRehabSweepSlice("rehab_ready", p, 3);
    expect(run1.selected.map((c) => c.id)).toEqual(["rec0000", "rec0001", "rec0002"]);
    const run2 = await nextRehabSweepSlice("rehab_ready", p, 3);
    expect(run2.selected.map((c) => c.id)).toEqual(["rec0003", "rec0004", "rec0005"]);
  });

  it("different keys rotate independently", async () => {
    const p = pool(10);
    await nextRehabSweepSlice("rehab_ready", p, 3);
    const other = await nextRehabSweepSlice("some_other_sweep", p, 3);
    expect(other.selected.map((c) => c.id)).toEqual(["rec0000", "rec0001", "rec0002"]);
  });
});
