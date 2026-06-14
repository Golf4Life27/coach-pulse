// Anchored autonomous opener gate (keystone 2026-06-13, spine
// recmgjlZSwhECn1W0 — Maverick Flag-2 ruling). @agent: crier
//
// SUPERSEDES the 65%-of-list door-opener and the prior tierAOpenerGuard.
//
// THE CAP IS THE ROUGH OPENER CEILING (lib/rough-opener-ceiling), NOT
// Your_MAO_V21. Flag-2: pointing the opener at V21 re-conflates the two
// numbers one field over. The opener caps on the cheap rough ceiling
// (rough ARV − rough rehab − fee, or a list-fraction fallback); the
// PRECISE CONTRACT MAO (V21 / future flipper comp-ARV) is a separate
// number that drives Contract_Offer_Price, never the opener.
//
//   opener_dollars = round(anchor_pct × rough_ceiling)
//
// HARD GATE (absolute): rough_ceiling null or ≤ 0 → NOT eligible for an
// autonomous send. Null is rare by design (the rough ceiling has a
// list-fraction fallback); ≤ 0 means rehab ate the whole buy-box — a
// genuinely bad deal that correctly HOLDs. Either routes to operator
// review per the existing dead-path logic.
//
// Anchor comes from lib/markets/anchor — Detroit 0.90; every market
// carries its own; the silent calibration job moves it. Market gate
// (priceable) retained as the registry gate.

export type OpenerGateReason =
  | "ok"
  | "market_not_priceable"
  | "ceiling_missing"          // rough ceiling null (no ARV and no list)
  | "ceiling_non_penciling"    // rough ceiling ≤ 0 → no autonomous send
  | "anchor_invalid";          // defensive — calibration drift

export interface AnchoredOpenerGateResult {
  ok: boolean;
  opener: number | null;
  reason: OpenerGateReason;
  detail: string | null;
  /** The rough ceiling the opener was anchored against (audit/telemetry). */
  ceiling: number | null;
  anchorPct: number | null;
}

export interface AnchoredOpenerGateInput {
  /** The ROUGH OPENER CEILING (lib/rough-opener-ceiling.computeRoughOpener
   *  Ceiling .ceiling) — the cap the anchor multiplies. NOT Your_MAO_V21. */
  ceiling: number | null | undefined;
  /** Effective market anchor from lib/markets/anchor.resolveAnchorPct. */
  anchorPct: number | null | undefined;
  /** Market priceability (the registry gate, unchanged). */
  priceable: boolean;
}

const positiveNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

export function anchoredOpenerGate(input: AnchoredOpenerGateInput): AnchoredOpenerGateResult {
  if (!input.priceable) {
    return {
      ok: false, opener: null,
      reason: "market_not_priceable",
      detail: "market is not priceable — opener is not computed for non-priceable markets",
      ceiling: null, anchorPct: null,
    };
  }
  if (input.ceiling == null) {
    return {
      ok: false, opener: null,
      reason: "ceiling_missing",
      detail: "rough opener ceiling is null (no ARV and no list price) — autonomous send refused; routes to operator review",
      ceiling: null, anchorPct: input.anchorPct ?? null,
    };
  }
  if (input.ceiling <= 0) {
    return {
      ok: false, opener: null,
      reason: "ceiling_non_penciling",
      detail: `rough ceiling $${input.ceiling.toLocaleString()} ≤ 0 — rehab eats the buy-box; record does not pencil, autonomous send refused`,
      ceiling: input.ceiling, anchorPct: input.anchorPct ?? null,
    };
  }
  if (!positiveNum(input.anchorPct)) {
    return {
      ok: false, opener: null,
      reason: "anchor_invalid",
      detail: "anchor_pct missing/invalid — calibration store unreachable; refusing to send blind",
      ceiling: input.ceiling, anchorPct: input.anchorPct ?? null,
    };
  }
  const opener = Math.round(input.ceiling * input.anchorPct);
  return {
    ok: opener > 0,
    opener: opener > 0 ? opener : null,
    reason: "ok",
    detail: `opener $${opener.toLocaleString()} = anchor ${input.anchorPct} × rough ceiling $${input.ceiling.toLocaleString()}`,
    ceiling: input.ceiling,
    anchorPct: input.anchorPct,
  };
}
