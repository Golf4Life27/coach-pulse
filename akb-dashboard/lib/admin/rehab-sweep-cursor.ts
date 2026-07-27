// Rehab-sweep rotating cursor (2026-07-27).
//
// THE STARVATION: the */5 cron always calls
// ?apply=1&selection=rehab_ready&limit=3 with no &after=. getRehabSweepCandidates
// returns the ~1,751-record eligible pool sorted (by the route) with the
// most-recently-verified record first, and the route always took
// filtered.slice(0, limit) — so every tick re-examined the SAME top 3
// records. Once those 3 finish (already_complete), eligible_total sits at
// 0 forever while un-appraised records deeper in the pool (e.g.
// reclICg9VGI57Bnsj, recGr6bYAGS7wzWqZ) are never reached.
//
// THE FIX: persist the id of the last record examined in KV. The next
// tick resumes just past it in the pool's CURRENT order (self-healing: if
// the stored id has since fallen out of the pool — re-verified away, gone
// Off Market, whatever — the cursor resets to the top instead of
// stalling). Reaching the end of the pool wraps back to index 0, so a
// bounded number of ticks visits the ENTIRE pool, not just its head.
//
// KV-backed with an in-memory fallback, same shape as the retire-me
// signal (lib/admin/retire-me-signal.ts). Fails OPEN on KV unavailability
// — a monitoring outage must not stall the sweep, so an unreadable/absent
// cursor degrades to today's un-cursored top-N slice. Never throws.

import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

const KV_KEY_PREFIX = "rehab-sweep:cursor:";
const CURSOR_TTL_S = 30 * 86_400; // 30 days — long outlives any real gap between cron ticks

const memoryRing = new Map<string, string>();

export interface CursorCandidate {
  id: string;
}

export interface RotatingSliceResult<T> {
  selected: T[];
  startIndex: number;
  /** True when this slice stitched the tail of the pool back to its head. */
  wrapped: boolean;
  /** id to persist as the cursor for the NEXT call (last record in this
   *  slice), or the incoming cursorId unchanged when the pool was empty. */
  nextCursorId: string | null;
}

/** Pure: rotate through `pool` starting just after `cursorId`. A cursor
 *  that's null, or no longer present in the pool (fell out of the
 *  eligible set since it was stored), restarts at index 0 — identical to
 *  having no cursor at all, so a stale/missing cursor can never wedge the
 *  sweep. Wraps past the end of the pool back to the start so the full
 *  pool gets covered over successive calls instead of just its head. */
export function selectRotatingSlice<T extends CursorCandidate>(
  pool: readonly T[],
  limit: number,
  cursorId: string | null,
): RotatingSliceResult<T> {
  const total = pool.length;
  if (total === 0 || limit <= 0) {
    return { selected: [], startIndex: 0, wrapped: false, nextCursorId: cursorId };
  }
  if (total <= limit) {
    // Nothing to rotate through — every tick covers the whole pool
    // anyway. Return it as-is (no wraparound stitching / duplicates).
    const last = pool[pool.length - 1];
    return { selected: [...pool], startIndex: 0, wrapped: false, nextCursorId: last.id };
  }
  const cursorIdx = cursorId ? pool.findIndex((p) => p.id === cursorId) : -1;
  const startIndex = cursorIdx === -1 ? 0 : (cursorIdx + 1) % total;
  const end = startIndex + limit;
  const selected =
    end <= total ? pool.slice(startIndex, end) : [...pool.slice(startIndex), ...pool.slice(0, end - total)];
  const nextCursorId = selected.length > 0 ? selected[selected.length - 1].id : cursorId;
  return { selected, startIndex, wrapped: end > total, nextCursorId };
}

async function readCursor(key: string): Promise<string | null> {
  if (kvConfigured()) {
    try {
      const v = await kvProd.get(`${KV_KEY_PREFIX}${key}`);
      if (typeof v === "string" && v.length > 0) return v;
    } catch {
      /* fall through — KV unreachable degrades to no cursor (top-N) */
    }
    return null;
  }
  return memoryRing.get(key) ?? null;
}

async function writeCursor(key: string, id: string): Promise<void> {
  if (kvConfigured()) {
    try {
      await kvProd.setEx(`${KV_KEY_PREFIX}${key}`, id, CURSOR_TTL_S);
      return;
    } catch {
      /* best-effort — worst case the next tick restarts at the top */
    }
  }
  memoryRing.set(key, id);
}

/** Read the persisted cursor, select the next rotating slice, and persist
 *  the new cursor for the next call. KV-unreachable (or unconfigured)
 *  degrades to today's top-N behavior — cursor reads as null (start at
 *  index 0) and the write is best-effort — never throws. */
export async function nextRehabSweepSlice<T extends CursorCandidate>(
  key: string,
  pool: readonly T[],
  limit: number,
): Promise<RotatingSliceResult<T>> {
  const cursorId = await readCursor(key);
  const result = selectRotatingSlice(pool, limit, cursorId);
  if (result.nextCursorId) {
    await writeCursor(key, result.nextCursorId);
  }
  return result;
}

/** Test-only — clear the in-memory ring between cases. */
export function _resetMemoryRing(): void {
  memoryRing.clear();
}
