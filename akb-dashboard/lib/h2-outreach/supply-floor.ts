// Supply-floor evaluator (operator 2026-06-11, spine recfcAUA0cX202utp).
// @agent: crier
//
// THE DOCTRINE: the system needs a daily minimum, ruled as a SUPPLY FLOOR,
// never a send QUOTA. A quota under empty supply pressures quality (the
// Hunt St shape: lineage breaches because the cron felt obligated to send
// something). A floor signals to the operator that the supply pipeline is
// underfeeding the cap, names the binding constraint, and lets the cap
// hold — the cron sends what's actually ready, no padding.
//
// At each h2-outreach tick we compute sendable_queue_depth: fresh +
// never-contacted + phone-unique + buyer-anchored records ready to text.
// Below SUPPLY_FLOOR we emit an info-tier audit alert naming the most
// likely binding constraint so the operator knows what to widen:
//   - intake_dry         CRAWLER_INTAKE_LIVE != "true" → the hunt is off
//   - zips_exhausted     ≤1 seeded ZIP in the buyer-median store →
//                        the map is one ZIP wide; cohort exhausted at
//                        current breadth
//   - stalled_behind_agents  more records waiting on active agent
//                            threads than ready to text → stall-release
//                            policy is the unlock
//   - natural_low_supply intake live and map widened but supply is just
//                        thin right now → routine, no action needed
//
// Pairs with the zero-output-streak detector: this fires on a single
// low-supply tick; the streak detector escalates when many ticks in a
// row produced zero sends. The two detectors share the same audit
// shape so the briefing surfaces them under one heading.

import { audit } from "@/lib/audit-log";

export const SUPPLY_FLOOR = 10;

export type BindingConstraint =
  | "intake_dry"
  | "zips_exhausted"
  | "stalled_behind_agents"
  | "natural_low_supply"
  | "supply_healthy";

export interface SupplyContext {
  /** Eligible-and-sendable count returned by the h2 selector this tick.
   *  This IS the sendable_queue_depth — fresh, never-contacted, phone-
   *  unique, buyer-anchored, all filters applied. */
  sendableQueueDepth: number;
  /** Of the selector's output, how many were skipped because they were
   *  behind a prior-contact stall (active agent thread). */
  stalledBehindAgents: number;
  /** CRAWLER_INTAKE_LIVE === "true". When false, the intake cron is a
   *  continuous dry-run no-op — the supply pipeline is OFF at the source. */
  intakeLive: boolean;
  /** Count of priceable seeded ZIPs (Buyer_Median_ZIP store ∩ buy-box).
   *  The narrowest binding constraint when the map is one ZIP wide. */
  seededZipsCount: number;
}

export interface SupplyFloorVerdict {
  alertNeeded: boolean;
  belowFloor: boolean;
  sendableQueueDepth: number;
  floor: number;
  bindingConstraint: BindingConstraint;
  /** Plain-English line for the operator. Same string used in audit. */
  description: string;
}

/** Pure: caller assembles the context, we return the verdict + the
 *  named binding constraint. Constraint precedence (most actionable
 *  first, so the alert prose names ONE thing): intake_dry > zips_
 *  exhausted > stalled_behind_agents > natural_low_supply. */
export function evaluateSupplyFloor(ctx: SupplyContext): SupplyFloorVerdict {
  const belowFloor = ctx.sendableQueueDepth < SUPPLY_FLOOR;
  if (!belowFloor) {
    return {
      alertNeeded: false,
      belowFloor: false,
      sendableQueueDepth: ctx.sendableQueueDepth,
      floor: SUPPLY_FLOOR,
      bindingConstraint: "supply_healthy",
      description: `${ctx.sendableQueueDepth} sendable ≥ floor ${SUPPLY_FLOOR}`,
    };
  }

  let constraint: BindingConstraint;
  let description: string;
  if (!ctx.intakeLive) {
    constraint = "intake_dry";
    description =
      `Sendable queue depth ${ctx.sendableQueueDepth} < floor ${SUPPLY_FLOOR}. ` +
      `Binding constraint: CRAWLER_INTAKE_LIVE is not "true" — listings-intake ` +
      `is a continuous dry-run no-op. The hunt is off at the source; supply ` +
      `cannot rise until the env flips after a clean dry-run probe.`;
  } else if (ctx.seededZipsCount <= 1) {
    constraint = "zips_exhausted";
    description =
      `Sendable queue depth ${ctx.sendableQueueDepth} < floor ${SUPPLY_FLOOR}. ` +
      `Binding constraint: only ${ctx.seededZipsCount} priceable seeded ZIP in ` +
      `Buyer_Median_ZIP. The map is one ZIP wide; cohort exhausted at the ` +
      `current breadth. Widening means seeding more ZIPs in the store.`;
  } else if (ctx.stalledBehindAgents >= ctx.sendableQueueDepth) {
    constraint = "stalled_behind_agents";
    description =
      `Sendable queue depth ${ctx.sendableQueueDepth} < floor ${SUPPLY_FLOOR}. ` +
      `Binding constraint: ${ctx.stalledBehindAgents} records held by ` +
      `prior-contact stalls (active agent threads) ≥ ${ctx.sendableQueueDepth} ` +
      `ready to text. Stall-release policy is the unlock.`;
  } else {
    constraint = "natural_low_supply";
    description =
      `Sendable queue depth ${ctx.sendableQueueDepth} < floor ${SUPPLY_FLOOR}. ` +
      `Binding constraint: intake live + map ${ctx.seededZipsCount} ZIPs wide + ` +
      `stalls below depth. Routine low-supply tick; no single lever to pull.`;
  }

  return {
    alertNeeded: true,
    belowFloor: true,
    sendableQueueDepth: ctx.sendableQueueDepth,
    floor: SUPPLY_FLOOR,
    bindingConstraint: constraint,
    description,
  };
}

/** Edge-side audit emit. Side-effecting; safe to call unconditionally —
 *  no audit row is written when supply is healthy. */
export async function emitSupplyFloorAudit(
  verdict: SupplyFloorVerdict,
  ctx: SupplyContext,
): Promise<void> {
  if (!verdict.alertNeeded) return;
  await audit({
    agent: "crier",
    event: "h2_supply_floor_below",
    status: "uncertain",
    inputSummary: {
      sendable_queue_depth: ctx.sendableQueueDepth,
      stalled_behind_agents: ctx.stalledBehindAgents,
      intake_live: ctx.intakeLive,
      seeded_zips_count: ctx.seededZipsCount,
    },
    outputSummary: {
      floor: verdict.floor,
      binding_constraint: verdict.bindingConstraint,
      description: verdict.description,
    },
    decision: "supply_floor_below",
  });
}
