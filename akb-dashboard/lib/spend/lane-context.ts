// Spend-lane context — WHICH KIND OF WORK is making the paid call.
// @agent: sentry
//
// The RentCast choke point (lib/rentcast.paidFetch → spend-ceiling) sees
// every call but not who is asking. Once the daily cap is throttled down
// (operator word 2026-09-05: "Throttle rentcast, we should be able to use
// Cowork to do most of its job"), that blindness becomes the failure mode:
// the 12:40Z sqft sweep and the 13:00Z intake would spend the whole day's
// allowance before a seller replies at 15:00Z and the appraiser needs one
// rent estimate. The lane is how the money path keeps its headroom.
//
// Node's AsyncLocalStorage scopes the lane to the request that declared it,
// so a warm container serving a sweep and then a live deal cannot leak one
// lane into the other (module-level state would). Routes wrap their handler
// in withSpendLane(); per-record routes that serve BOTH a sweep and a live
// caller read the lane from the x-spend-lane header the sweep forwards.
//
// Undeclared work is "batch" — half the throttle — so a call site nobody
// remembered to tag yields before the live lane does, never after.

import { AsyncLocalStorage } from "node:async_hooks";
import type { SpendLane } from "./paid-call-lanes";

const storage = new AsyncLocalStorage<SpendLane>();

/** Request header a sweep forwards so a shared per-record route inherits
 *  the sweep's lane instead of defaulting to "live". */
export const SPEND_LANE_HEADER = "x-spend-lane";

/** What an untagged call site is treated as. */
export const DEFAULT_SPEND_LANE: SpendLane = "batch";

const LANES: readonly SpendLane[] = ["sweep", "batch", "discovery", "live"];

export function isSpendLane(v: unknown): v is SpendLane {
  return typeof v === "string" && (LANES as readonly string[]).includes(v);
}

/** The lane of the work currently executing; DEFAULT_SPEND_LANE outside
 *  any withSpendLane() scope. */
export function currentSpendLane(): SpendLane {
  return storage.getStore() ?? DEFAULT_SPEND_LANE;
}

/** Run fn with every paid call inside it attributed to `lane`. */
export function withSpendLane<T>(lane: SpendLane, fn: () => Promise<T>): Promise<T> {
  return storage.run(lane, fn);
}

/** Lane for a request: the forwarded header when it names a real lane,
 *  otherwise `fallback` (per-record routes pass "live" — a human button or
 *  the engaged path is the only other caller). */
export function laneFromRequest(req: Request, fallback: SpendLane): SpendLane {
  const raw = req.headers.get(SPEND_LANE_HEADER);
  return isSpendLane(raw) ? raw : fallback;
}
