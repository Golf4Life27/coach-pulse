// Outreach economics guard — 2026-06-05.
// @agent: orchestrator
//
// Two operator-locked hard prerequisites the H2 (Crier) sender must pass
// BEFORE any SMS goes out. Both replace existing PHANTOM gates that read
// fields which don't exist in the Listings_V1 schema and therefore
// silently let everything through (or silently blocked deal-action's
// safety-check path — the gates were dead code either way).
//
//   1. >85%-of-list block — the offer amount in the outgoing message
//      may not exceed 85% of List_Price. The crawler intake script
//      mechanically generates an offer at 65% of List_Price; an offer
//      above 85% is either a math bug, an operator override that
//      bypassed the floor, or a fee-inflated number. BLOCK.
//
//   2. First-outreach hydration prerequisite — a first outreach (no
//      prior Last_Outreach_Date) requires real ARV + rehab inputs
//      before sending an offer. Previously gated on `preOfferScreenAt`
//      (schema field doesn't exist → always-null → either always-block
//      from deal-action or always-pass-through from h2). Replaces that
//      phantom with the real fields: `arvValidatedAt` AND
//      `rehabEstimatedAt`.
//
// Both checks are PURE — no I/O. Caller passes listing + message body.

import { getMarketForListing } from "@/lib/markets/registry";
import { evaluateDeal } from "@/lib/markets/deal-math";
import { computeListingMao, type UnderwriteContext } from "@/lib/track-aware-underwrite";

/** The 85% threshold. Operator-tunable via env without a deploy. The
 *  intake script targets 65%, so 85% gives operator headroom for
 *  per-deal upward adjustments — but never further than 85%. */
export const OFFER_OVER_LIST_BLOCK_PCT = (() => {
  const raw = process.env.OUTREACH_MAX_OFFER_OVER_LIST_PCT;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.85;
})();

export interface OfferEconomicsCheck {
  ok: boolean;
  offerAmount: number | null;
  listPrice: number | null;
  ratio: number | null;
  blockedBecause: string | null;
}

/** Pure: extract the offer dollar amount from a Crier-shaped message
 *  body. Looks for "cash offer at $N,NNN" / "offer of $N,NNN" / generic
 *  "$N,NNN" patterns. Returns the FIRST plausible offer amount or null.
 *  We bound the result to a residential offer range to avoid
 *  accidentally picking up a list-price echo or a phone number. */
export function extractOfferAmountFromMessage(body: string): number | null {
  if (!body) return null;
  const PHRASES = [/cash offer at\s*\$\s*([\d,]+)/i, /cash offer of\s*\$\s*([\d,]+)/i, /offer at\s*\$\s*([\d,]+)/i, /offer of\s*\$\s*([\d,]+)/i];
  for (const re of PHRASES) {
    const m = body.match(re);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 1_000 && n < 5_000_000) return Math.round(n);
    }
  }
  // Fallback: first $-amount in the body.
  const m = body.match(/\$\s*([\d,]+)/);
  if (m) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 1_000 && n < 5_000_000) return Math.round(n);
  }
  return null;
}

/** Pure: BLOCK when the parsed offer amount > thresholdPct × listPrice.
 *  When inputs are insufficient to compute the ratio (missing offer or
 *  list price), the check PASSES — the caller is expected to have
 *  separate hydration guards (checkFirstOutreachHydration). The intent
 *  here is to catch a numerically-anomalous offer, not to gate on
 *  missing data. */
export function checkOfferOverList(
  messageBody: string,
  listPrice: number | null | undefined,
  thresholdPct: number = OFFER_OVER_LIST_BLOCK_PCT,
): OfferEconomicsCheck {
  const offerAmount = extractOfferAmountFromMessage(messageBody);
  const lp = typeof listPrice === "number" && Number.isFinite(listPrice) && listPrice > 0 ? listPrice : null;
  if (offerAmount == null || lp == null) {
    return { ok: true, offerAmount, listPrice: lp, ratio: null, blockedBecause: null };
  }
  const ratio = offerAmount / lp;
  if (ratio > thresholdPct) {
    return {
      ok: false,
      offerAmount,
      listPrice: lp,
      ratio: Math.round(ratio * 1000) / 1000,
      blockedBecause:
        `offer $${offerAmount.toLocaleString()} > ${Math.round(thresholdPct * 100)}% of list $${lp.toLocaleString()} (ratio ${(ratio * 100).toFixed(1)}%) — too aggressive vs. list; refuse send`,
    };
  }
  return { ok: true, offerAmount, listPrice: lp, ratio: Math.round(ratio * 1000) / 1000, blockedBecause: null };
}

// ── Opener-vs-MAO guard (2026-06-09) ─────────────────────────────────
// The 65%-of-list door-opener must NEVER exceed the deal's underwritten
// MAO. On efficiently-priced on-market inventory where list ≈ ARV, a flat
// 65%-of-list opener can sit ABOVE our own ceiling — worse than a lowball,
// because we'd be offering more than we can pay. Where 65%-list > MAO we
// cap the opener at MAO (rounded down to the nearest $250 so it never
// exceeds), or skip + flag when the capped number falls below a sane floor.
//
// Runs ONLY in priceable markets (a sourced buy-box discount exists, so a
// real MAO can be computed). Unpriceable markets pass through unchanged —
// they have no MAO to compare against and are gated elsewhere.

/** Minimum opener we'll send. Mirrors the $5K floor the H2 selector uses. */
export const MIN_OPENER_USD = 5000;

export interface OpenerMaoGuard {
  /** false = skip the listing (do not send). */
  ok: boolean;
  /** The opener to send — capped to MAO when needed; null when skipping. */
  opener: number | null;
  /** The raw 65%-of-list opener that was checked. */
  baseOpener: number | null;
  /** The deal's underwritten MAO the opener was checked against. */
  mao: number | null;
  /** True when the opener was reduced down to the MAO ceiling. */
  capped: boolean;
  /** Surfaced reason for a cap or skip; null when no action was needed. */
  reason: string | null;
}

const positiveNum = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

/** Pure: cap or skip the door-opener so it never exceeds the deal's MAO.
 *  Only acts in priceable markets; elsewhere the opener passes through. */
export function openerMaoGuard(input: {
  baseOpener: number | null | undefined;
  mao: number | null | undefined;
  priceable: boolean;
}): OpenerMaoGuard {
  const base = positiveNum(input.baseOpener) ? input.baseOpener : null;
  const mao = positiveNum(input.mao) ? input.mao : null;

  // Guard only runs in priceable markets.
  if (!input.priceable) {
    return { ok: true, opener: base, baseOpener: base, mao, capped: false, reason: null };
  }
  if (base == null) {
    return { ok: true, opener: base, baseOpener: base, mao, capped: false, reason: null };
  }
  // Priceable but no MAO → we cannot guarantee opener ≤ MAO, and a priceable
  // market is exactly where we CAN price. Don't send blind: skip + flag.
  if (mao == null) {
    return {
      ok: false,
      opener: null,
      baseOpener: base,
      mao: null,
      capped: false,
      reason: "mao_not_underwritten — no persisted Underwritten_MAO and ZIP-store unavailable; run the underwrite station before sending an opener",
    };
  }
  if (base <= mao) {
    return { ok: true, opener: base, baseOpener: base, mao, capped: false, reason: null };
  }
  // base > mao → cap to MAO, rounded DOWN to $250 so we never exceed it.
  const cappedOpener = Math.floor(mao / 250) * 250;
  if (cappedOpener < MIN_OPENER_USD) {
    return {
      ok: false,
      opener: null,
      baseOpener: base,
      mao,
      capped: false,
      reason: `opener $${base.toLocaleString()} (65% list) > MAO $${mao.toLocaleString()}; capped $${cappedOpener.toLocaleString()} below min $${MIN_OPENER_USD.toLocaleString()} — skip + flag`,
    };
  }
  return {
    ok: true,
    opener: cappedOpener,
    baseOpener: base,
    mao,
    capped: true,
    reason: `opener capped: 65%-list $${base.toLocaleString()} > MAO $${mao.toLocaleString()} → send at MAO $${cappedOpener.toLocaleString()}`,
  };
}

export interface OpenerCeiling {
  /** Underwritten MAO (deal-math) — null on HOLD / unpriceable. */
  mao: number | null;
  /** Whether the deal's market has a sourced buy-box discount. */
  priceable: boolean;
  /** Resolved market id for audit, or null when no market matched. */
  market: string | null;
}

/** Pure: resolve the deal's MAO ceiling + market priceability. PRIORITY:
 *  (1) persisted listing.underwrittenMao — what the underwrite station wrote;
 *      the resolver's primary read path so a send-time decision does NOT
 *      depend on a live ZIP-store I/O round-trip.
 *  (2) TRACK-AWARE ZIP-store via the pre-loaded UnderwriteContext — the
 *      landlord as-is median is already a purchase price; legitimate fallback
 *      when an intake row is too fresh for the station to have written yet.
 *  (3) evaluateDeal (flipper-only: ARV × arv_pct_max − rehab − fee) — runs
 *      ONLY when ARV+rehab are actually on the record. If neither (1) nor (2)
 *      nor any ARV/rehab is present, the resolver SURFACES the failure
 *      distinctly ("mao_not_underwritten") instead of silently falling through
 *      and emitting the misleading "priceable_market_mao_unknown — underwrite
 *      (ARV + rehab) before sending an opener" — that masquerade caused the
 *      2026-06-09 48227 dry-run-zero incident.
 *
 *  NOTE: contractOfferPrice is INTENTIONALLY NOT read here — it is V2.1-
 *  reserved for the DD-time contract number set by the INV-023 gate after
 *  CMA + rehab, and must stay empty until DD sets it. */
export function resolveOpenerCeiling(
  listing: {
    state?: string | null;
    zip?: string | null;
    realArvMedian?: number | null;
    estRehab?: number | null;
    listPrice?: number | null;
    redFlags?: string[] | string | null;
    distressBucket?: string | null;
    distressScore?: number | null;
    underwrittenMao?: number | null;
  },
  ctx?: UnderwriteContext,
): OpenerCeiling {
  const market = getMarketForListing({ state: listing.state, zip: listing.zip });
  const priceable = market?.buyer_params?.arv_pct_max != null;
  if (!priceable) {
    return { mao: null, priceable: false, market: market?.id ?? null };
  }
  // (1) Persisted Underwritten_MAO — preferred. The send path reads what the
  // underwrite station wrote; no live I/O dependency.
  if (typeof listing.underwrittenMao === "number" && listing.underwrittenMao > 0) {
    return { mao: listing.underwrittenMao, priceable: true, market: market?.id ?? null };
  }
  // (2) Track-aware ZIP-store via pre-loaded context — legitimate fallback
  // for intake rows too fresh for the station to have written yet.
  if (ctx) {
    const uw = computeListingMao(
      {
        state: listing.state ?? null,
        zip: listing.zip ?? null,
        redFlags: listing.redFlags ?? null,
        distressBucket: listing.distressBucket ?? null,
        distressScore: listing.distressScore ?? null,
        estRehab: listing.estRehab ?? null,
      },
      ctx,
    );
    if (uw.yourMao != null) {
      return { mao: uw.yourMao, priceable: true, market: market?.id ?? null };
    }
  }
  // (3) evaluateDeal — ONLY when ARV+rehab are actually present. Otherwise we
  // surface a DISTINCT failure rather than silently emit the misleading
  // "needs ARV+rehab" error. Silent fallback = defect.
  const hasArvRehab =
    typeof listing.realArvMedian === "number" && listing.realArvMedian > 0 &&
    typeof listing.estRehab === "number" && listing.estRehab >= 0;
  if (hasArvRehab) {
    const res = evaluateDeal(
      { arv: listing.realArvMedian, rehab: listing.estRehab, listPrice: listing.listPrice },
      market,
    );
    return { mao: res.mao, priceable: true, market: market?.id ?? null };
  }
  // No persisted MAO, no ZIP-store median, no ARV+rehab → distinct error.
  // Distinguishes "the lead was never underwritten" from "ARV+rehab are
  // missing for a deal-math run." The openerMaoGuard surfaces this reason
  // verbatim so the cause is unmistakable.
  return { mao: null, priceable: true, market: market?.id ?? null };
}

export interface FirstOutreachHydrationCheck {
  ok: boolean;
  isFirstOutreach: boolean;
  missing: string[];
  blockedBecause: string | null;
}

/** Pure: a FIRST outreach (no prior Last_Outreach_Date) requires that
 *  the ARV and rehab pipelines have both run, so the offer is grounded.
 *  Replaces the phantom `preOfferScreenAt` gate that always read null.
 *  Returns ok:true (no gate) when this isn't a first outreach. */
export function checkFirstOutreachHydration(input: {
  lastOutreachDate: string | null | undefined;
  arvValidatedAt: string | null | undefined;
  rehabEstimatedAt: string | null | undefined;
}): FirstOutreachHydrationCheck {
  const isFirstOutreach = !input.lastOutreachDate;
  if (!isFirstOutreach) {
    return { ok: true, isFirstOutreach, missing: [], blockedBecause: null };
  }
  const missing: string[] = [];
  if (!input.arvValidatedAt) missing.push("arvValidatedAt");
  if (!input.rehabEstimatedAt) missing.push("rehabEstimatedAt");
  if (missing.length === 0) {
    return { ok: true, isFirstOutreach, missing: [], blockedBecause: null };
  }
  return {
    ok: false,
    isFirstOutreach,
    missing,
    blockedBecause:
      `first outreach requires hydrated pricing inputs; missing: ${missing.join(", ")}. Run ARV + rehab pipelines first`,
  };
}
