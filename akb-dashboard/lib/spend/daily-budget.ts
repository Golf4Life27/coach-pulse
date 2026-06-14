// Daily spend ceiling — the master throttle for crawler frontier
// expansion (Maverick 2026-06-14, national-crawler build, ruling #4).
//
// WHAT IT CLAMPS: new ZIP SEEDS (each = a paid comp pull), NOT the whole
// loop. Budget-hit PAUSES new seeds; already-seeded ZIPs keep pricing for
// free (their ARV $/sqft is cached in ZIP_ARV_Seed — zero paid calls). So
// the cap governs how fast the national frontier grows, never the steady-
// state pricing of markets already covered.
//
// NO PARALLEL METER: spend is derived from the SAME agent:audit paid_api_call
// entries the Pulse paid_api_spend_24h detector + lib/spend/derive already
// read (counts), converted to dollars via a tunable per-call cost table.
// derive.ts deliberately deferred dollar-isation; this is that conversion,
// kept here and env-tunable so Alex sets the real per-call prices later.
//
// Pure decision split from the async audit read for tests.

import { readRecentFromKv } from "@/lib/audit-log";
import { countCallsBySource24h, type SpendCountsBySource } from "@/lib/spend/derive";

/** Master daily ceiling, USD. Default LOW ($25) until Alex sets the real
 *  number (operator ruling #4). Env: DAILY_INTAKE_BUDGET_USD. */
export const DEFAULT_DAILY_INTAKE_BUDGET_USD = 25;

export function dailyBudgetUsd(): number {
  const raw = Number(process.env.DAILY_INTAKE_BUDGET_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_INTAKE_BUDGET_USD;
}

/** Per-call cost ESTIMATES (USD). These are not vendor-exact — they are the
 *  conversion knob from the count-based meter to dollars. Tune via env once
 *  real per-call prices are known; the ceiling math is what matters. */
export interface PerCallCosts {
  rentcast: number;
  attom: number;
}
export function perCallCosts(): PerCallCosts {
  const rc = Number(process.env.RENTCAST_CALL_COST_USD);
  const at = Number(process.env.ATTOM_CALL_COST_USD);
  return {
    rentcast: Number.isFinite(rc) && rc >= 0 ? rc : 0.20,
    attom: Number.isFinite(at) && at >= 0 ? at : 0.50,
  };
}

/** Cost of ONE new ZIP seed = one comp pull. Defaults to a single RentCast
 *  /avm/value call (comps embedded). Env: SEED_COST_USD overrides. */
export function seedCostUsd(): number {
  const raw = Number(process.env.SEED_COST_USD);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return perCallCosts().rentcast;
}

/** Pure: dollar-ise the 24h paid-call counts. */
export function estimateDailySpendUsd(counts: SpendCountsBySource, costs: PerCallCosts): number {
  return Math.round((counts.rentcast * costs.rentcast + counts.attom * costs.attom) * 100) / 100;
}

export interface SeedBudgetVerdict {
  /** May the crawler spend a paid comp pull for a NEW ZIP seed right now? */
  canSeed: boolean;
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  /** How many more seeds fit under the ceiling at the current seed cost. */
  seedsRemaining: number;
  seedCostUsd: number;
  reason: string;
}

/** Pure: can we afford another seed under the daily ceiling? A seed is
 *  allowed only when the CURRENT spend plus one more seed stays at/under the
 *  budget — so the ceiling is never crossed by the very call we authorize. */
export function evaluateSeedBudget(input: {
  spentUsd: number;
  budgetUsd: number;
  seedCostUsd: number;
}): SeedBudgetVerdict {
  const remainingUsd = Math.round((input.budgetUsd - input.spentUsd) * 100) / 100;
  const seedsRemaining = input.seedCostUsd > 0 ? Math.max(0, Math.floor(remainingUsd / input.seedCostUsd)) : 0;
  const canSeed = input.seedCostUsd > 0 && input.spentUsd + input.seedCostUsd <= input.budgetUsd;
  return {
    canSeed,
    spentUsd: input.spentUsd,
    budgetUsd: input.budgetUsd,
    remainingUsd,
    seedsRemaining,
    seedCostUsd: input.seedCostUsd,
    reason: canSeed
      ? `under ceiling: $${input.spentUsd.toFixed(2)} spent of $${input.budgetUsd.toFixed(2)}, ${seedsRemaining} seed(s) of headroom`
      : `daily seed budget exhausted: $${input.spentUsd.toFixed(2)} of $${input.budgetUsd.toFixed(2)} — new ZIP seeds PAUSED (already-seeded ZIPs keep pricing free)`,
  };
}

/** Async: read the 24h paid-call spend and return the seed-budget verdict.
 *  Fails OPEN-CLOSED toward safety: on an audit-read failure it assumes the
 *  budget is exhausted (no new seeds) rather than spending blind. */
export async function resolveSeedBudget(now: Date = new Date()): Promise<SeedBudgetVerdict> {
  const budgetUsd = dailyBudgetUsd();
  const cost = seedCostUsd();
  try {
    const audit = await readRecentFromKv(5000);
    const counts = countCallsBySource24h(audit, now);
    const spentUsd = estimateDailySpendUsd(counts, perCallCosts());
    return evaluateSeedBudget({ spentUsd, budgetUsd, seedCostUsd: cost });
  } catch {
    return {
      canSeed: false,
      spentUsd: budgetUsd, // treat as fully spent — never seed on an unknown meter
      budgetUsd,
      remainingUsd: 0,
      seedsRemaining: 0,
      seedCostUsd: cost,
      reason: "spend meter unreadable — pausing new seeds (fail-safe; pricing of seeded ZIPs is unaffected)",
    };
  }
}
