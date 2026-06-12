// Flipper lane — property-up MAO (keystone rewrite, spine recfrqeVgAr53CdDP,
// adjudicated recXJrM7EYK3pEFmF). @agent: appraiser
//
// THE DOCTRINE: a ZIP buyer-median can never price a specific property —
// it informs (market gate, sanity rail, dispo triage) but never authorizes.
// The offer ceiling is PROPERTY-UP:
//
//   flipperValue = ARV(this property) − margin(the buyer who'd buy it)
//   Investor_MAO = flipperValue − Rehab(this property)
//   Your_MAO     = Investor_MAO − wholesale_fee
//
// This module is the deliberate twin of lib/landlord-lane.computeLandlordMax:
// property-specific sourced inputs, HOLD with explicit reason on ANY null,
// no fabricated defaults, routed through the SAME computeInvestorMao /
// computeYourMao as the landlord lane (lib/pre-contract-math).
//
// MARGIN SEMANTICS (two tiers, two kinds):
//   Tier C (autonomous): the matched buyer's Min_Deal_Spread — a DOLLAR
//     figure on the Buyers table (currency field). marginDollars = spread.
//   Tier B (operator-approved offers): the market's sourced buy-box
//     arv_pct_max — a FRACTION of ARV the buyer pays (e.g. Detroit
//     0.6461). margin fraction = 1 − arv_pct_max; marginDollars =
//     ARV × (1 − arv_pct_max). Lineage provisional_operator_approved;
//     NEVER autonomous; Tier B HOLDs in any market whose arv_pct_max
//     is unsourced (arv_source_verified=false).
//
// Both kinds normalize to marginDollars so one formula serves both:
//   flipperValue = ARV − marginDollars.

export type FlipperMargin =
  | { kind: "buyer_min_deal_spread"; dollars: number }
  | { kind: "market_arv_pct_max"; arvPctMax: number };

export interface FlipperLaneInputs {
  /** Real_ARV_Median — Appraiser comp-sourced. AVM-as-ARV is forbidden;
   *  callers must pass the comp-sourced field, never an AVM estimate. */
  arv: number | null | undefined;
  margin: FlipperMargin | null | undefined;
}

export interface FlipperLaneResult {
  status: "ok" | "hold";
  /** ARV − marginDollars: what the matched/market buyer would pay for the
   *  RENOVATED property. null on HOLD. */
  flipperValue: number | null;
  marginDollars: number | null;
  marginKind: FlipperMargin["kind"] | null;
  missing: string[];
  reason: string;
}

function validPositive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Pure: compute the property-up flipper value (the renovated-basis buyer
 * max). HOLD when ANY input is missing/invalid — no fabricated margins,
 * no AVM-as-ARV, no per-market or per-buyer-type defaults on Tier C
 * (operator adjudication recXJrM7EYK3pEFmF item 1).
 */
export function computeFlipperMax(inputs: FlipperLaneInputs): FlipperLaneResult {
  const missing: string[] = [];

  if (!validPositive(inputs.arv)) missing.push("arv");

  let marginDollars: number | null = null;
  let marginKind: FlipperMargin["kind"] | null = null;
  const m = inputs.margin;
  if (m == null) {
    missing.push("margin");
  } else if (m.kind === "buyer_min_deal_spread") {
    marginKind = m.kind;
    if (!validPositive(m.dollars)) missing.push("margin_dollars");
    else marginDollars = Math.round(m.dollars);
  } else if (m.kind === "market_arv_pct_max") {
    marginKind = m.kind;
    // A sourced buy-box fraction must be in (0, 1) — 0 or 1 means the
    // registry row is corrupt, not "buyer pays full ARV".
    if (typeof m.arvPctMax !== "number" || !Number.isFinite(m.arvPctMax) || m.arvPctMax <= 0 || m.arvPctMax >= 1) {
      missing.push("market_arv_pct_max");
    } else if (validPositive(inputs.arv)) {
      marginDollars = Math.round((inputs.arv as number) * (1 - m.arvPctMax));
    }
  } else {
    missing.push("margin_kind");
  }

  if (missing.length > 0) {
    return {
      status: "hold",
      flipperValue: null,
      marginDollars: null,
      marginKind,
      missing,
      reason: `Flipper lane HOLD — missing/invalid input(s): ${missing.join(", ")}. No fabricated margins; source the input before computing.`,
    };
  }

  const arv = inputs.arv as number;
  const flipperValue = Math.round(arv - (marginDollars as number));

  // A margin that consumes the whole ARV means no buyer max exists at
  // these numbers — HOLD (not a flipper deal), never a fake value.
  if (flipperValue <= 0) {
    return {
      status: "hold",
      flipperValue: null,
      marginDollars,
      marginKind,
      missing: [],
      reason: `Flipper lane HOLD — margin $${(marginDollars as number).toLocaleString()} ≥ ARV $${arv.toLocaleString()}; no positive buyer max at these numbers.`,
    };
  }

  return {
    status: "ok",
    flipperValue,
    marginDollars,
    marginKind,
    missing: [],
    reason: `flipperValue $${flipperValue.toLocaleString()} = ARV $${arv.toLocaleString()} − margin $${(marginDollars as number).toLocaleString()} (${marginKind}).`,
  };
}
