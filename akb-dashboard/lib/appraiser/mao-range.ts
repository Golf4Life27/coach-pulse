// Phase 4A.1 — Appraiser MAO-range math.
// @agent: appraiser
//
// Pure helpers for the standalone /api/agents/appraiser/arv/[recordId]
// endpoint. Two surfaces:
//
//   classifyArvConfidenceByCount  — count-based confidence per the Phase
//     4A.1 spec (HIGH 5+, MED 3-4, LOW <3 → Manual Review). Separate
//     from `lib/arv-intelligence.ts`'s internal confidence rubric, which
//     considers cluster quality / market type / filter survival. The
//     count rule is the dashboard-facing label; the internal rubric is
//     informational in the audit trail.
//
//   computeMaoRange  — v1.3 range envelope per Phase 20.2 amendment.
//     Returns { floor, target, list_price, modifier_inputs }. Floor is
//     the V2.1 never-go-below math (arv − rehab − wholesale_fee).
//     Target defaults to floor when seller_motivation_score is null;
//     the motivation-modifier formula is deferred to Phase 13 (Sentinel
//     auto-scoring). Alex's framing: "65% opens the door, then DD
//     reveals whether to drop to 61% (worse rehab) or push to 71%
//     (clean deal + motivated seller). V2.1 is the never-go-below
//     floor; seller motivation is the modifier."
//
// Defaults used when listing fields are null:
//   wholesaleFeeTarget = DEFAULT_WHOLESALE_FEE ($5K — operational
//     floor per SYSTEM_FACTS §9, Spine rec6e6hYLuOpaLANf 2026-06-04;
//     was the original Bible v3 §9 $15K target — reconciled to the
//     same constant `pre-contract-math.ts:DEFAULT_WHOLESALE_FEE`
//     uses so BroCard pricing + PC-27 share one fee).
//   buyerProfitTarget = 30000 (informational; not in floor formula)
//
// Note: floor here does NOT subtract buyer_profit. That's because the
// "MAO floor" semantically is "the most we'd pay assuming a buyer takes
// every dollar of expected profit." The Pricing Agent's Phase 4C math
// separately computes investor_mao (subtracts buyer_profit) vs your_mao
// (subtracts buyer_profit + wholesale_fee). For the Appraiser ARV
// endpoint's range, floor = your_mao when full buyer profit is reserved
// — but we expose modifier_inputs so callers can recompute under
// different assumptions.

import { computeDualTrack, type DualTrackResult } from "./buyer-intelligence";
// Single fee-constant source of truth (Spine rec6e6hYLuOpaLANf,
// reconciled 2026-06-04). Both this module and the pre-contract math
// gate read from the same definition so the BroCard pricing layer and
// PC-27 can't drift.
import { DEFAULT_WHOLESALE_FEE } from "@/lib/pre-contract-math";

export type ArvConfidenceLabel = "HIGH" | "MED" | "LOW";

// Buyer_Profit_Target RETIRED as an authorizing input (keystone rewrite
// 2026-06-12, adjudication recXJrM7EYK3pEFmF item 4). It was never in the
// floor formula; it now also never DEFAULTS — a fabricated $30k rendered
// on a pricing card is what the 4/26 fabrication rule forbids. The raw
// field (null when unset) passes through modifier_inputs for display.
// The matched buyer's Min_Deal_Spread (lib/flipper-lane) replaced it as
// the margin concept.
const SOFT_CEILING_FRACTION_OF_LIST = 0.75;

/**
 * Phase 4A.1 spec — count-based confidence label.
 *   5+ comps → HIGH
 *   3-4 comps → MED
 *   <3 comps → LOW (Manual Review)
 *
 * Pure. Negative or null counts collapse to LOW.
 */
export function classifyArvConfidenceByCount(
  compCountUsed: number | null | undefined,
): ArvConfidenceLabel {
  if (compCountUsed == null || !Number.isFinite(compCountUsed) || compCountUsed < 0) return "LOW";
  if (compCountUsed >= 5) return "HIGH";
  if (compCountUsed >= 3) return "MED";
  return "LOW";
}

/** Whether the Phase 4A.1 result should route to Manual Review. */
export function requiresManualReview(confidence: ArvConfidenceLabel): boolean {
  return confidence === "LOW";
}

export interface RehabSource {
  /** Phase 4B.1 calibrated mid (Bible v3 §4.2 BBC × market multiplier). */
  estRehabMid?: number | null;
  /** Legacy Phase 4 estRehab field. Used as fallback when estRehabMid
   *  is missing (records last touched before Phase 4B.1 shipped). */
  estRehab?: number | null;
}

export interface CalibratedRehabPick {
  /** The chosen rehab value the MAO floor formula uses. Null when
   *  neither field is populated. */
  value: number | null;
  /** Which field the value came from — surfaced in audit so future
   *  Pulse can detect when MAO floors are still being computed from
   *  legacy estRehab (signals records that haven't been re-calibrated
   *  by Phase 4B.1). */
  source: "phase_4b_calibrated" | "legacy_est_rehab" | "none";
}

/**
 * Phase 4B.1 / J.3 — pick the most trustworthy rehab value for the
 * V2.1 MAO floor formula. Prefers Phase 4B.1 calibrated output
 * (estRehabMid) over legacy estRehab. Pure.
 *
 * The two fields can both be present (Phase 4B endpoint writes both).
 * They can also differ when only the legacy field was set by an old
 * Pricing Agent run. The pick rule is: estRehabMid > estRehab > null.
 */
export function pickCalibratedRehab(source: RehabSource): CalibratedRehabPick {
  if (source.estRehabMid != null && source.estRehabMid > 0) {
    return { value: source.estRehabMid, source: "phase_4b_calibrated" };
  }
  if (source.estRehab != null && source.estRehab > 0) {
    return { value: source.estRehab, source: "legacy_est_rehab" };
  }
  return { value: null, source: "none" };
}

export interface MaoRangeInputs {
  /** Real_ARV_Median computed by lib/arv-intelligence.ts.computeArvIntelligence. */
  arvMid: number | null;
  /** Listing.Est_Rehab (or Est_Rehab_Mid fallback). */
  estRehab: number | null;
  /** Listing.Wholesale_Fee_Target; defaults to DEFAULT_WHOLESALE_FEE
   *  ($5,000 — operator_locked, Spine 2026-06-03) when null. The old
   *  doc here claimed 15000 — stale since the fee consolidation. */
  wholesaleFee: number | null;
  /** Listing.Buyer_Profit_Target — RETIRED (2026-06-12). Never defaulted,
   *  never authorizes; raw value passes through modifier_inputs only. */
  buyerProfit?: number | null;
  /** Listing.List_Price; surfaced in the envelope for caller reference. */
  listPrice: number | null;
  /** Listing.Seller_Motivation_Score (1-5, optional); reserved for Phase 13. */
  sellerMotivationScore: number | null;
  /** Phase 4C.1 — Listing.Estimated_Monthly_Rent. When present alongside
   *  state, computeMaoRange runs dual-track and uses dominant_value as
   *  the floor (instead of flipper-only math). When null/missing,
   *  falls back to flipper-only floor. */
  monthlyRent?: number | null;
  /** Phase 4C.1 — Listing.State, used to resolve per-market cap rate
   *  for the landlord track. Ignored when monthlyRent is null. */
  state?: string | null;
  /** Sourced per-market buy-box ARV%Max (registry, e.g. Detroit 0.6461).
   *  Its PRESENCE marks the market as priceable — the value is not applied
   *  to the floor here (the V2.1 floor stays the never-go-below), it gates
   *  whether a floor may surface at all. See requireSourcedDiscount. */
  arvDiscountPct?: number | null;
  /** When true, HOLD (null floor + target) unless arvDiscountPct is a sourced
   *  fraction in (0, 1] — so no resale-minus-rehab floor can surface on the
   *  deal page for an UNPRICEABLE market (e.g. San Antonio, buyer_params:null).
   *  Opt-in: existing callers default to false and are unaffected. Mirrors the
   *  same HOLD posture as resolveBuyerCeiling. */
  requireSourcedDiscount?: boolean;
}

export interface MaoRange {
  /** V2.1 never-go-below floor. When dual-track ran (monthlyRent +
   *  state both present), this equals dominant_value (higher of flipper
   *  vs landlord MAO). When dual-track did NOT run, this equals the
   *  flipper-only math: MAX(arvMid − estRehab − wholesaleFee, 0).
   *  Null when inputs are missing (cannot compute either track). */
  floor: number | null;
  /** Seller-motivation-adjusted target. Equals floor when motivation
   *  score is null (Phase 13 enriches the modifier formula). */
  target: number | null;
  /** Listing's current List_Price for caller reference. */
  list_price: number | null;
  /** Soft ceiling: anything above 75% of List triggers a Maverick
   *  caution flag on the deal-detail page. Null when list_price missing. */
  soft_ceiling: number | null;
  /** True when target exceeds soft_ceiling — caller surfaces caution flag. */
  exceeds_soft_ceiling: boolean;
  /** Set when the floor/target were forced to HOLD because the market is
   *  unpriceable (requireSourcedDiscount with no sourced buy-box discount).
   *  null in the normal (priceable / not-gated) case. */
  hold_reason?: string | null;
  /** Phase 4C.1 — dual-track sub-payload when monthlyRent + state were
   *  both present at compute time. Surfaces both track values so the UI
   *  can render the breakdown without re-running the math. Null when
   *  computeMaoRange ran in flipper-only mode (no rent or no state). */
  dual_track: DualTrackResult | null;
  /** All inputs that feed (or will feed) the modifier formula. Exposed so
   *  Phase 13 / future motivation logic can be applied client-side without
   *  a re-fetch. */
  modifier_inputs: {
    arv_mid: number | null;
    est_rehab: number | null;
    wholesale_fee: number;
    buyer_profit: number | null;
    list_price: number | null;
    seller_motivation_score: number | null;
    monthly_rent: number | null;
    state: string | null | undefined;
  };
}

/**
 * Pure: project the listing's known inputs into the v1.3 MAO range
 * envelope. Both arvMid and estRehab must be present to compute the
 * floor; either-null returns null floor + null target.
 */
export function computeMaoRange(opts: MaoRangeInputs): MaoRange {
  const wholesaleFee = opts.wholesaleFee ?? DEFAULT_WHOLESALE_FEE;
  const buyerProfit = opts.buyerProfit ?? null; // retired input — no fabricated default
  const softCeiling =
    opts.listPrice != null && opts.listPrice > 0
      ? Math.round(opts.listPrice * SOFT_CEILING_FRACTION_OF_LIST)
      : null;

  // Unpriceable-market HOLD (opt-in). When the caller requires a sourced
  // buy-box discount and the market has none, HOLD floor + target so no
  // resale-minus-rehab number can surface on the deal page. The V2.1 floor
  // is ARV − rehab − fee; without a sourced discount we cannot stand behind
  // it as an offer, so we show nothing rather than a misleading number.
  const hasSourcedDiscount =
    typeof opts.arvDiscountPct === "number" && opts.arvDiscountPct > 0 && opts.arvDiscountPct <= 1;
  if (opts.requireSourcedDiscount && !hasSourcedDiscount) {
    return {
      floor: null,
      target: null,
      list_price: opts.listPrice,
      soft_ceiling: softCeiling,
      exceeds_soft_ceiling: false,
      hold_reason: "unpriceable_market_no_sourced_buybox_discount",
      dual_track: null,
      modifier_inputs: {
        arv_mid: opts.arvMid,
        est_rehab: opts.estRehab,
        wholesale_fee: wholesaleFee,
        buyer_profit: buyerProfit,
        list_price: opts.listPrice,
        seller_motivation_score: opts.sellerMotivationScore,
        monthly_rent: opts.monthlyRent ?? null,
        state: opts.state ?? null,
      },
    };
  }

  // Phase 4C.1 — run dual-track when monthlyRent + state both present.
  // dominant_value (the higher of flipper vs landlord MAO) becomes the
  // floor. When dual-track inputs are missing, fall back to flipper-only
  // math as before — preserves backward compatibility for callers that
  // don't yet pass rent/state.
  const dualTrackEligible =
    opts.monthlyRent != null && opts.monthlyRent > 0 && opts.state != null;
  const dualTrack: DualTrackResult | null = dualTrackEligible
    ? computeDualTrack({
        arvMid: opts.arvMid,
        estRehab: opts.estRehab,
        wholesaleFee: opts.wholesaleFee,
        monthlyRent: opts.monthlyRent ?? null,
        state: opts.state,
      })
    : null;

  if (opts.arvMid == null || opts.estRehab == null) {
    // When ARV or rehab missing, dual-track also returns
    // dominant_value=null UNLESS only rent + arv present (landlord-only)
    // — in that case dual_track has the landlord answer. Fall through
    // to dual-track's dominant_value when available.
    const fallbackFloor = dualTrack?.dominant_value ?? null;
    const fallbackTarget = fallbackFloor;
    return {
      floor: fallbackFloor,
      target: fallbackTarget,
      list_price: opts.listPrice,
      soft_ceiling: softCeiling,
      exceeds_soft_ceiling: false,
      hold_reason: null,
      dual_track: dualTrack,
      modifier_inputs: {
        arv_mid: opts.arvMid,
        est_rehab: opts.estRehab,
        wholesale_fee: wholesaleFee,
        buyer_profit: buyerProfit,
        list_price: opts.listPrice,
        seller_motivation_score: opts.sellerMotivationScore,
        monthly_rent: opts.monthlyRent ?? null,
        state: opts.state ?? null,
      },
    };
  }

  // Floor = dual-track dominant when available; flipper-only fallback
  // otherwise. Both paths produce non-negative values (computeDualTrack
  // clamps individual track values to 0; flipper-only path uses MAX).
  const flipperOnlyFloor = Math.max(opts.arvMid - opts.estRehab - wholesaleFee, 0);
  const floor = dualTrack?.dominant_value ?? flipperOnlyFloor;
  // Phase 4A.1 ships target = floor (no motivation modifier yet).
  // Phase 13 will apply the seller-motivation-adjusted modifier on top.
  const target = floor;
  const exceedsSoftCeiling =
    softCeiling != null && target > softCeiling;

  return {
    floor,
    target,
    list_price: opts.listPrice,
    soft_ceiling: softCeiling,
    exceeds_soft_ceiling: exceedsSoftCeiling,
    hold_reason: null,
    dual_track: dualTrack,
    modifier_inputs: {
      arv_mid: opts.arvMid,
      est_rehab: opts.estRehab,
      wholesale_fee: wholesaleFee,
      buyer_profit: buyerProfit,
      list_price: opts.listPrice,
      seller_motivation_score: opts.sellerMotivationScore,
      monthly_rent: opts.monthlyRent ?? null,
      state: opts.state ?? null,
    },
  };
}
