// INV-026 — Progress Meter compute layer (pure).
//
// Three load-bearing numbers per the brief, plus a build-completion
// secondary. All pure functions over the stage registry + a Deals
// snapshot + the operator-hours estimate, so the API route is thin I/O.

import {
  PIPELINE_STAGES,
  INFRA_COMPLETION,
  OPERATOR_HOURS_ESTIMATE,
  DEAL_VELOCITY_TARGET,
  type PipelineStage,
  type LostPhoneRisk,
} from "./stages";

// ── 1. Lost-Phone-Test ────────────────────────────────────────────────

export interface LostPhoneResult {
  high: number;
  medium: number;
  low: number;
  expectedManual: number;
  /** The headline: stages that STALL if the operator is gone 7 days. */
  stallCount: number;
  /** Stages contributing to the stall count, by id. */
  stallingStages: string[];
}

export function countLostPhoneRisk(stages: PipelineStage[] = PIPELINE_STAGES): LostPhoneResult {
  const tally: Record<LostPhoneRisk, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, EXPECTED_MANUAL: 0 };
  const stallingStages: string[] = [];
  for (const s of stages) {
    tally[s.lostPhoneRisk]++;
    if (s.stallsWithoutOperator) stallingStages.push(s.id);
  }
  return {
    high: tally.HIGH,
    medium: tally.MEDIUM,
    low: tally.LOW,
    expectedManual: tally.EXPECTED_MANUAL,
    stallCount: stallingStages.length,
    stallingStages,
  };
}

// ── 2. Deal velocity ──────────────────────────────────────────────────

export interface ClosedDeal {
  /** ISO date the deal realized (assignment executed / closed). null = undated. */
  closedAt: string | null;
  /** Realized $ (assignment_fee). null/0 counted as 0. */
  assignmentFee: number | null;
}

export interface DealVelocityResult {
  windowDays: number;
  closedInWindow: number;
  totalFeeInWindow: number;
  /** Net $/month over the window (totalFee / (windowDays/30)). */
  monthlyNetUsd: number;
  /** Deals/month over the window. */
  monthlyCount: number;
  targetMonthlyNetUsd: number;
  /** monthlyNet as a fraction of the $40K/mo Crawler-2.0 target (0-1+). */
  pctOfTarget: number;
}

export function dealVelocity(
  deals: ClosedDeal[],
  now: Date = new Date(),
  windowDays = 90,
): DealVelocityResult {
  const cutoff = now.getTime() - windowDays * 86_400_000;
  let closedInWindow = 0;
  let totalFeeInWindow = 0;
  for (const d of deals) {
    if (!d.closedAt) continue;
    const t = Date.parse(d.closedAt);
    if (!Number.isFinite(t) || t < cutoff || t > now.getTime()) continue;
    closedInWindow++;
    totalFeeInWindow += d.assignmentFee && d.assignmentFee > 0 ? d.assignmentFee : 0;
  }
  const months = windowDays / 30;
  const monthlyNetUsd = Math.round(totalFeeInWindow / months);
  const monthlyCount = Number((closedInWindow / months).toFixed(2));
  const target = DEAL_VELOCITY_TARGET.monthlyNetUsd;
  return {
    windowDays,
    closedInWindow,
    totalFeeInWindow,
    monthlyNetUsd,
    monthlyCount,
    targetMonthlyNetUsd: target,
    pctOfTarget: Number((monthlyNetUsd / target).toFixed(3)),
  };
}

// ── 3. Operator hours (estimate passthrough) ──────────────────────────

export interface OperatorHoursResult {
  lowHours: number;
  highHours: number;
  targetHours: number;
  /** Midpoint as a multiple of target (e.g. 3.0 = 300% over). */
  overTargetMultiple: number;
  measured: boolean;
  asOf: string;
}

export function operatorHours(est = OPERATOR_HOURS_ESTIMATE): OperatorHoursResult {
  const mid = (est.lowHours + est.highHours) / 2;
  return {
    lowHours: est.lowHours,
    highHours: est.highHours,
    targetHours: est.targetHours,
    overTargetMultiple: Number((mid / est.targetHours).toFixed(2)),
    measured: est.measured,
    asOf: est.asOf,
  };
}

// ── Build-completion (secondary — % is the misleading frame per INV-026) ─

export interface CompletionResult {
  /** Simple mean of pipeline-stage completion (the "front half works, back
   *  half is the unbuilt money" number). */
  pipelinePct: number;
  infraPct: number;
  /** Blended: pipeline weighted 70%, infra 30% (infra enables but doesn't close deals). */
  overallPct: number;
  perStage: Array<{ id: string; name: string; station: number; pct: number; risk: LostPhoneRisk }>;
}

export function buildCompletion(stages: PipelineStage[] = PIPELINE_STAGES): CompletionResult {
  const pipelinePct = Math.round(
    stages.reduce((sum, s) => sum + s.completionPct, 0) / stages.length,
  );
  const infraPct = INFRA_COMPLETION.pct;
  const overallPct = Math.round(pipelinePct * 0.7 + infraPct * 0.3);
  return {
    pipelinePct,
    infraPct,
    overallPct,
    perStage: stages.map((s) => ({
      id: s.id,
      name: s.name,
      station: s.station,
      pct: s.completionPct,
      risk: s.lostPhoneRisk,
    })),
  };
}

// ── Snapshot assembler ────────────────────────────────────────────────

export interface MeterSnapshot {
  asOf: string;
  lostPhone: LostPhoneResult;
  velocity: DealVelocityResult;
  operatorHours: OperatorHoursResult;
  completion: CompletionResult;
  /** One-line headline for the dashboard tile + Spine row. */
  headline: string;
}

export function buildMeterSnapshot(args: {
  deals: ClosedDeal[];
  now?: Date;
  windowDays?: number;
  stages?: PipelineStage[];
}): MeterSnapshot {
  const now = args.now ?? new Date();
  const stages = args.stages ?? PIPELINE_STAGES;
  const lostPhone = countLostPhoneRisk(stages);
  const velocity = dealVelocity(args.deals, now, args.windowDays ?? 90);
  const hours = operatorHours();
  const completion = buildCompletion(stages);
  const headline =
    `${lostPhone.stallCount} stages stall without operator (${lostPhone.high} HIGH) · ` +
    `$${velocity.monthlyNetUsd.toLocaleString()}/mo (target $${velocity.targetMonthlyNetUsd.toLocaleString()}) · ` +
    `~${hours.lowHours}-${hours.highHours}h/wk (target ${hours.targetHours}) · ` +
    `build ${completion.overallPct}%`;
  return {
    asOf: now.toISOString(),
    lostPhone,
    velocity,
    operatorHours: hours,
    completion,
    headline,
  };
}
