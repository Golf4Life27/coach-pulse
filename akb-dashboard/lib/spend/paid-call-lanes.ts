// Shared paid-API spend meter — ONE ceiling, LANE PRIORITY (2026-07-29).
// @agent: pulse
//
// WHY THIS EXISTS. Per-path budgets failed twice, and the second failure
// cost the operator real money. The frontier governor shipped 2026-07-11
// and was reported as "RentCast spend is now governed" — but it only ever
// wrapped the ZIP crawler. Within nine days three ungoverned features
// shipped on top of it (auto-underwrite on engaged deals 7/13, the ARV
// burn-down accelerator 7/18, outreach volume scaling 7/22). Measured
// usage went 2 calls/day (7/08) -> 12/day (7/12) -> 231/day, on a
// 1,000-call/month plan: 6,247 calls in 27 days and ~$1,470 in charges.
// An audit on 7/29 found only 2 of ~10 paid call paths had ANY budget
// check.
//
// The lesson is architectural, not tactical: a per-path budget is a
// promise that decays the moment anyone ships a new path. This module is
// the choke point — the same shape that made outbound texts safe once
// every send had to pass through sendGuarded.
//
// THE DESIGN. One shared 24h ceiling over BOTH paid vendors (RentCast +
// ATTOM — comp pulls moved to ATTOM on 7/19, so a RentCast-only meter
// would be blind to its own biggest consumer). Lanes are not equal: a
// graveyard sweep and a live seller negotiation must not compete on
// equal terms for the last call of the day. Each lane yields at a
// FRACTION of the ceiling, so lower-priority work stops first and the
// money lane keeps its headroom.
//
// FAILS OPEN. An unreadable meter returns "allowed" everywhere. A
// monitoring outage must never stall live deals — the per-shape loop
// breaker and each route's own `limit` remain the backstops. This
// mirrors auto-underwrite-engaged's long-standing posture.
//
// Pure decision logic here; the KV read lives in the caller so this
// stays unit-testable with no I/O.

/** Work classes, most deferrable first. The fraction each may consume of
 *  the shared daily ceiling before it yields. */
export type SpendLane =
  /** Back-catalog sweeps over records nobody is negotiating on. First to
   *  yield — per the operator ruling of 2026-07-13, ~95% of intake is
   *  unworkable and paid data does not belong on it. */
  | "sweep"
  /** Scheduled batch underwriting of cold-but-plausible records. */
  | "batch"
  /** Top-of-funnel discovery. Cheap per call and the only thing that
   *  finds new inventory, so it outranks batch work. */
  | "discovery"
  /** A live deal: a seller replied, an offer is moving. Never yields
   *  before anything else — this is the lane that earns revenue. */
  | "live";

/** Fraction of the shared ceiling each lane may consume before yielding. */
export const LANE_BUDGET_FRACTION: Record<SpendLane, number> = {
  sweep: 0.25,
  batch: 0.5,
  discovery: 0.75,
  live: 1.0,
};

/** Shared 24h ceiling across RentCast + ATTOM, in calls.
 *
 *  Default 250/day (~7,500/mo) is deliberately ABOVE the 1,000-call plan:
 *  it is a RUNAWAY BRAKE, not a plan-sizing tool. Setting it to the plan's
 *  implied ~33/day would stall the pipeline outright. The purpose is to
 *  make spend BOUNDED AND PREDICTABLE so the plan can then be right-sized
 *  to observed steady-state — an unbounded system cannot be sized at all.
 *  Lower it via PAID_CALLS_DAILY_CEILING as the waste fixes land. */
export function paidCallsDailyCeiling(): number {
  const raw = Number(process.env.PAID_CALLS_DAILY_CEILING);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 250;
}

/** Effective ceiling for one lane. */
export function laneCeiling(lane: SpendLane, ceiling = paidCallsDailyCeiling()): number {
  return Math.floor(ceiling * LANE_BUDGET_FRACTION[lane]);
}

export interface LaneSpendVerdict {
  allowed: boolean;
  /** Null when the meter was unreadable (fail-open). */
  spent24h: number | null;
  laneCeiling: number;
  ceiling: number;
  lane: SpendLane;
  reason: "ok" | "lane_ceiling_reached" | "meter_unreadable_fail_open";
}

/**
 * Pure: may this lane spend a paid call right now?
 *
 * `spent24h` is the combined RentCast+ATTOM 24h count (from
 * countCallsBySource24h) or null if the meter could not be read.
 */
export function checkLaneSpend(
  lane: SpendLane,
  spent24h: number | null,
  ceiling = paidCallsDailyCeiling(),
): LaneSpendVerdict {
  const lc = laneCeiling(lane, ceiling);
  if (spent24h == null) {
    return {
      allowed: true,
      spent24h: null,
      laneCeiling: lc,
      ceiling,
      lane,
      reason: "meter_unreadable_fail_open",
    };
  }
  if (spent24h >= lc) {
    return {
      allowed: false,
      spent24h,
      laneCeiling: lc,
      ceiling,
      lane,
      reason: "lane_ceiling_reached",
    };
  }
  return { allowed: true, spent24h, laneCeiling: lc, ceiling, lane, reason: "ok" };
}
