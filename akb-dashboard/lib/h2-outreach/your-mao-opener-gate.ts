// Your_MAO-gated autonomous opener (operator brief 2026-06-13, spine
// recZ6tBZRmfFOLwqo). @agent: crier
//
// SUPERSEDES the 65%-of-list door-opener and the prior tierAOpenerGuard
// entirely. The bug: the prior opener was computed off list price and
// IGNORED Your_MAO — every planned opener sat above its own ceiling.
//
// New formula:
//   opener_dollars = round(anchor_pct × Your_MAO)
//
// HARD GATE (absolute, no exceptions):
//   Your_MAO null or ≤ 0 → NOT eligible for an autonomous send. The
//   record routes to operator review per the existing dead-path logic.
//   We never compute or send an opener for a non-penciling record.
//
// Anchor comes from lib/markets/anchor — Detroit launches at 0.90;
// every market carries its own anchor; the silent calibration job
// (lib/markets/anchor-calibration) moves it.
//
// Market gate retained: a record in an unpriceable market is skipped
// the same way it always was — the priceable check is the registry
// gate, not a pricing decision.

export type YourMaoGateReason =
  | "ok"
  | "market_not_priceable"
  | "your_mao_missing"             // null/undefined Your_MAO formula
  | "your_mao_non_penciling"       // Your_MAO ≤ 0 → no autonomous send
  | "anchor_invalid";              // defensive — calibration drift

export interface YourMaoOpenerGateResult {
  ok: boolean;
  opener: number | null;
  reason: YourMaoGateReason;
  detail: string | null;
  /** Surfaced for the audit row / probe telemetry. */
  yourMao: number | null;
  anchorPct: number | null;
}

export interface YourMaoOpenerGateInput {
  /** Per-record Your_MAO from the formula field (legacy_Your_MAO,
   *  fldfE06eS402RcPCN). Maverick's by-hand verification 2026-06-12
   *  on 26 fully-populated Detroit records: the formula is correct. */
  yourMao: number | null | undefined;
  /** Effective market anchor from lib/markets/anchor.resolveAnchorPct. */
  anchorPct: number | null | undefined;
  /** Market priceability (the registry gate, unchanged). */
  priceable: boolean;
}

const positiveNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

export function yourMaoOpenerGate(input: YourMaoOpenerGateInput): YourMaoOpenerGateResult {
  if (!input.priceable) {
    return {
      ok: false, opener: null,
      reason: "market_not_priceable",
      detail: "market is not priceable — opener is not computed for non-priceable markets",
      yourMao: null, anchorPct: null,
    };
  }
  if (input.yourMao == null) {
    return {
      ok: false, opener: null,
      reason: "your_mao_missing",
      detail: "Your_MAO is null — autonomous send refused (hard gate per 2026-06-13 doctrine); record routes to operator review",
      yourMao: null, anchorPct: input.anchorPct ?? null,
    };
  }
  if (input.yourMao <= 0) {
    return {
      ok: false, opener: null,
      reason: "your_mao_non_penciling",
      detail: `Your_MAO $${input.yourMao.toLocaleString()} ≤ 0 — record does not pencil; autonomous send refused`,
      yourMao: input.yourMao, anchorPct: input.anchorPct ?? null,
    };
  }
  if (!positiveNum(input.anchorPct)) {
    return {
      ok: false, opener: null,
      reason: "anchor_invalid",
      detail: "anchor_pct missing/invalid — calibration store unreachable; refusing to send blind",
      yourMao: input.yourMao, anchorPct: input.anchorPct ?? null,
    };
  }
  const opener = Math.round(input.yourMao * input.anchorPct);
  return {
    ok: opener > 0,
    opener: opener > 0 ? opener : null,
    reason: "ok",
    detail: `opener $${opener.toLocaleString()} = anchor ${input.anchorPct} × Your_MAO $${input.yourMao.toLocaleString()}`,
    yourMao: input.yourMao,
    anchorPct: input.anchorPct,
  };
}
