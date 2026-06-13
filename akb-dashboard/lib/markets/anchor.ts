// Per-market opener anchor — Your_MAO × anchor_pct = the autonomous-send
// opener (operator brief 2026-06-13, spine recZ6tBZRmfFOLwqo). Replaces
// the 65%-of-list door-opener entirely. @agent: crier
//
// DOCTRINE:
//   - opener = anchor_pct × Your_MAO. The opener is a fraction of the
//     property's penciling MAO, never derived from list price.
//   - Anchor is per-market. Detroit launches at 0.90; every market
//     carries its own anchor.
//   - HARD CEILING 1.00: above 1.00 means we spend operator fee to buy
//     responses; the loop never crosses this on autopilot. Crossing
//     requires explicit operator approval.
//   - HARD FLOOR 0.75: below this the conversation degrades faster than
//     the math improves; operator-research territory.
//   - The calibration loop (lib/markets/anchor-calibration) decides
//     movement; this module only resolves the current effective value.

import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

/** Detroit-launch default (operator 2026-06-13). Every newly-active
 *  market starts here until calibration accumulates its baseline. */
export const DEFAULT_ANCHOR_PCT = 0.90;

/** Autopilot ceiling — crossing means we're paying our own fee away to
 *  buy responses. The loop probes freely up to here, never past it. */
export const ANCHOR_AUTOPILOT_CEILING = 1.00;

/** Below this the opener is so low the agent relationship pays the cost
 *  for any reply we get. Calibration cannot step under this on its own. */
export const ANCHOR_FLOOR = 0.75;

const KV_PREFIX = "market:anchor:";

export interface MarketAnchorState {
  marketId: string;
  /** Current effective anchor (always within [FLOOR, AUTOPILOT_CEILING]). */
  anchorPct: number;
  /** First-tick-of-baseline marker for the 2-week / 200-send gate. */
  baselineStartedAt: string | null;
  /** Established baseline reply rate (replies / sends). null until set. */
  baselineReplyRate: number | null;
  /** Sends since the last anchor change — the 50-send sample gate. */
  sendsSinceLastChange: number;
  /** Wall-clock of the last anchor change for the audit trail. */
  lastAnchorChangeAt: string | null;
  /** Consecutive calibration cycles pinned at the autopilot ceiling
   *  with still-near-zero replies — feeds the unworkable-market
   *  circuit breaker. */
  pinAtCeilingCycles: number;
  /** Set when the breaker trips. Calibration stops moving the market;
   *  the operator-review flag goes in audit (NEVER a UI alert). */
  brokenAt: string | null;
}

/** Pure: a fresh state at the default anchor. New markets land here. */
export function freshAnchorState(marketId: string, now: Date = new Date()): MarketAnchorState {
  return {
    marketId,
    anchorPct: DEFAULT_ANCHOR_PCT,
    baselineStartedAt: now.toISOString(),
    baselineReplyRate: null,
    sendsSinceLastChange: 0,
    lastAnchorChangeAt: null,
    pinAtCeilingCycles: 0,
    brokenAt: null,
  };
}

/** Pure: clamp to autopilot bounds. The operator-approval lane that
 *  legitimately crosses 1.00 writes a different lineage; this function
 *  only enforces what the autopilot may set. */
export function clampToAutopilot(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULT_ANCHOR_PCT;
  if (pct < ANCHOR_FLOOR) return ANCHOR_FLOOR;
  if (pct > ANCHOR_AUTOPILOT_CEILING) return ANCHOR_AUTOPILOT_CEILING;
  return pct;
}

// ── KV I/O — load/save state per market ──────────────────────────────

async function readKv(marketId: string): Promise<MarketAnchorState | null> {
  if (!kvConfigured()) return null;
  try {
    const v = await kvProd.get(`${KV_PREFIX}${marketId}`);
    if (typeof v === "string" && v.length > 0) return JSON.parse(v) as MarketAnchorState;
  } catch {
    /* fall through to null */
  }
  return null;
}

async function writeKv(state: MarketAnchorState): Promise<void> {
  if (!kvConfigured()) return;
  try {
    // No TTL — calibration state must persist across the entire
    // baseline + adaptive horizon, indefinitely.
    await kvProd.set(`${KV_PREFIX}${state.marketId}`, JSON.stringify(state));
  } catch {
    /* best-effort; calibration will detect the drift next cycle */
  }
}

/** Load the persisted state, or synthesize a fresh one — never throws. */
export async function loadAnchorState(marketId: string, now: Date = new Date()): Promise<MarketAnchorState> {
  return (await readKv(marketId)) ?? freshAnchorState(marketId, now);
}

export async function saveAnchorState(state: MarketAnchorState): Promise<void> {
  await writeKv(state);
}

/** Resolve the effective anchor for the send path. Cron-friendly: one
 *  read per market per tick, called inside a cache when multiple records
 *  share a market. */
export async function resolveAnchorPct(marketId: string | null): Promise<number> {
  if (!marketId) return DEFAULT_ANCHOR_PCT;
  const state = await loadAnchorState(marketId);
  return clampToAutopilot(state.anchorPct);
}
