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

/** Lowball floor (operator 2026-06-10, standing rule). A capped opener
 *  below this fraction of list_price signals pricing-lineage mismatch
 *  (e.g. a deal-math fallback in a market without a buyer median, the
 *  3684 Hunt St breach: $13,500 / $100k ≈ 13.5%). HOLD for operator
 *  review rather than burn the agent. Env-tunable. */
export const LOWBALL_FLOOR_PCT_OF_LIST = (() => {
  const raw = Number(process.env.H2_LOWBALL_FLOOR_PCT_OF_LIST);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.35;
})();

/** Lineages authorized to drive an AUTONOMOUS offer number.
 *
 *  KEYSTONE REWRITE (operator 2026-06-12, spine recfrqeVgAr53CdDP,
 *  adjudication recXJrM7EYK3pEFmF): a ZIP buyer-median can never price a
 *  specific property. The median lineages (buyer_underwrite_persisted /
 *  buyer_zip_store_live) are DEMOTED to informational — they gate markets,
 *  cross-check numbers, and triage dispo, but never authorize. Only the
 *  property-up lineage authorizes autonomously (Tier C); it requires a
 *  matched POF-verified buyer's sourced Min_Deal_Spread and is expected
 *  to price ZERO records until buyer data accrues — that is correct.
 *  This supersedes the 2026-06-10 BUYER-ANCHORED ONLY set. */
const AUTONOMOUS_AUTHORIZED_SOURCES: ReadonlySet<MaoLineage> = new Set([
  "property_underwrite_persisted",
]);

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
 *  Only acts in priceable markets; elsewhere the opener passes through.
 *
 *  Autonomous-send extras (operator 2026-06-10, h2-outreach cron only):
 *    - requireBuyerAnchored — refuse when MAO lineage is deal_math or null.
 *      Seeding a market's buyer median is what opens its autonomous lane.
 *    - listPrice + LOWBALL_FLOOR_PCT_OF_LIST — capped opener below 35% of
 *      list HOLDs for operator review (lineage-mismatch smell). */
export function openerMaoGuard(input: {
  baseOpener: number | null | undefined;
  mao: number | null | undefined;
  priceable: boolean;
  /** MaoLineage from resolveOpenerCeiling. Required when
   *  requireBuyerAnchored=true; ignored otherwise. */
  source?: MaoLineage | null;
  /** Autonomous-cron switch: refuse non-buyer-anchored lineages. */
  requireBuyerAnchored?: boolean;
  /** Listing list price, for the lowball-floor check. */
  listPrice?: number | null;
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
  // Buyer-anchored lineage gate (autonomous send paths only). MAO from
  // deal-math is analysis-grade, not send-authorizing. The 3684 Hunt St
  // breach: 48207 has no seeded buyer median, deal-math priced it at
  // $13,658 → cap $13,500 against ~$100k list, autonomously schedulable
  // without this gate. Refuse explicitly so adding a buyer median (not
  // hardcoding a ZIP) is what opens a market's autonomous lane.
  if (input.requireBuyerAnchored && (input.source == null || !AUTONOMOUS_AUTHORIZED_SOURCES.has(input.source))) {
    return {
      ok: false,
      opener: null,
      baseOpener: base,
      mao,
      capped: false,
      reason: `mao_lineage_not_autonomous_authorized (source=${input.source ?? "null"}) — only property_underwrite_persisted authorizes an autonomous offer number (keystone 2026-06-12); median lineages inform, never authorize`,
    };
  }
  // Lowball floor (autonomous-path rule, gated by requireBuyerAnchored —
  // operator-supervised paths keep operator judgment): a sub-35%-of-list
  // opener signals lineage mismatch and burns the agent for nothing.
  // Applied on BOTH the base opener (≤ MAO branch) and the capped opener
  // (base > MAO branch) because a deep cap is the same smell.
  const lowballApplies = input.requireBuyerAnchored === true && input.listPrice != null && input.listPrice > 0;
  const lowballFloor = lowballApplies ? (input.listPrice as number) * LOWBALL_FLOOR_PCT_OF_LIST : 0;
  const lowballReason = (n: number) =>
    `lowball_below_${Math.round(LOWBALL_FLOOR_PCT_OF_LIST * 100)}pct_of_list — opener $${n.toLocaleString()} < ${Math.round(LOWBALL_FLOOR_PCT_OF_LIST * 100)}% of list $${(input.listPrice as number).toLocaleString()} ($${Math.round(lowballFloor).toLocaleString()} floor); HOLD for operator review`;
  if (base <= mao) {
    if (lowballApplies && base < lowballFloor) {
      return { ok: false, opener: null, baseOpener: base, mao, capped: false, reason: lowballReason(base) };
    }
    return { ok: true, opener: base, baseOpener: base, mao, capped: false, reason: null };
  }
  // base > mao → cap to MAO, rounded DOWN to $250 so we never exceed it.
  const cappedOpener = Math.floor(mao / 250) * 250;
  if (lowballApplies && cappedOpener < lowballFloor) {
    return { ok: false, opener: null, baseOpener: base, mao, capped: false, reason: lowballReason(cappedOpener) };
  }
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
  /** The resolved ceiling — null on HOLD / unpriceable. Whether it may
   *  drive an autonomous number is authorizedForAutonomous, NOT presence. */
  mao: number | null;
  /** Whether the deal's market has a sourced buy-box discount. */
  priceable: boolean;
  /** Resolved market id for audit, or null when no market matched. */
  market: string | null;
  /** Lineage of the MAO number. As of the 2026-06-12 keystone, ONLY
   *  property_underwrite_persisted authorizes autonomously; median
   *  lineages are informational (sanity rail / alerts / dispo triage). */
  source: MaoLineage | null;
  /** True only when source ∈ AUTONOMOUS_AUTHORIZED_SOURCES. */
  authorizedForAutonomous: boolean;
}

export type MaoLineage =
  | "property_underwrite_persisted" // (0) listing.underwrittenPropertyMao — PROPERTY-UP; the ONLY autonomous-authorizing lineage (keystone 2026-06-12)
  | "provisional_operator_approved" // Tier B — computeFlipperMax on market arv_pct_max; operator offer-approval flow ONLY, never autonomous
  | "buyer_underwrite_persisted"    // (1) listing.underwrittenMao — median-based; INFORMATIONAL as of 2026-06-12 (was send-authorizing)
  | "buyer_zip_store_live"          // (2) UnderwriteContext ZIP-store median — INFORMATIONAL as of 2026-06-12 (was send-authorizing)
  | "deal_math";                    // (3) evaluateDeal ARV×arv_pct_max-rehab-fee — informs analysis only (unchanged)

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
    underwrittenPropertyMao?: number | null;
  },
  ctx?: UnderwriteContext,
): OpenerCeiling {
  const market = getMarketForListing({ state: listing.state, zip: listing.zip });
  const priceable = market?.buyer_params?.arv_pct_max != null;
  const out = (mao: number | null, source: MaoLineage | null): OpenerCeiling => ({
    mao,
    priceable,
    market: market?.id ?? null,
    source,
    authorizedForAutonomous: source != null && AUTONOMOUS_AUTHORIZED_SOURCES.has(source),
  });
  if (!priceable) {
    return out(null, null);
  }
  // (0) PROPERTY-UP persisted ceiling — the keystone (2026-06-12). Written
  // only by the property-up pipeline (ARV − matched buyer margin − rehab −
  // fee). The ONLY lineage that authorizes an autonomous number.
  if (typeof listing.underwrittenPropertyMao === "number" && listing.underwrittenPropertyMao > 0) {
    return out(listing.underwrittenPropertyMao, "property_underwrite_persisted");
  }
  // (1) Persisted median-based Underwritten_MAO — INFORMATIONAL as of
  // 2026-06-12 (was send-authorizing). Surfaces for alerts/sanity-rail;
  // authorizedForAutonomous=false.
  if (typeof listing.underwrittenMao === "number" && listing.underwrittenMao > 0) {
    return out(listing.underwrittenMao, "buyer_underwrite_persisted");
  }
  // (2) Track-aware ZIP-store via pre-loaded context — INFORMATIONAL as of
  // 2026-06-12. A ZIP average prices no single house.
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
      return out(uw.yourMao, "buyer_zip_store_live");
    }
  }
  // (3) evaluateDeal — informs analysis only (unchanged posture; the 3684
  // Hunt St lesson). Never authorizes.
  const hasArvRehab =
    typeof listing.realArvMedian === "number" && listing.realArvMedian > 0 &&
    typeof listing.estRehab === "number" && listing.estRehab >= 0;
  if (hasArvRehab) {
    const res = evaluateDeal(
      { arv: listing.realArvMedian, rehab: listing.estRehab, listPrice: listing.listPrice },
      market,
    );
    return out(res.mao, "deal_math");
  }
  // No ceiling of any lineage → distinct null.
  return out(null, null);
}

// ── Tier A door-opener guard (keystone 2026-06-12, adjudication item 1) ──
// The autonomous door-opener is 65% of list — a conversation starter, not a
// committed price. It is NOT capped by any median-derived ceiling (median
// informs, never authorizes — in either direction). The committed number
// happens later on Tier B (operator-approved computeFlipperMax ceiling with
// mandatory inspection contingency) or Tier C (property-up autonomous).
//
// Gates that remain on Tier A: priceable market (the median's market-gate
// role, unchanged), positive opener, the 35%-of-list lowball floor (a 65%
// opener passes trivially; the floor protects against corrupted MAO_V1
// values), and never-over-list.
export interface TierAOpenerGuardResult {
  ok: boolean;
  opener: number | null;
  reason: string | null;
}

export function tierAOpenerGuard(input: {
  /** The 65%-of-list door-opener (MAO_V1). */
  opener: number | null | undefined;
  listPrice?: number | null;
  /** Market priceability from resolveOpenerCeiling — the market gate. */
  priceable: boolean;
}): TierAOpenerGuardResult {
  const opener = positiveNum(input.opener) ? input.opener : null;
  if (!input.priceable) {
    return { ok: false, opener: null, reason: "market_not_priceable — Tier A sends only in gated markets" };
  }
  if (opener == null) {
    return { ok: false, opener: null, reason: "opener_missing — MAO_V1 (65% of list) is null/zero; will not text a $0 offer" };
  }
  if (input.listPrice != null && input.listPrice > 0) {
    const floor = input.listPrice * LOWBALL_FLOOR_PCT_OF_LIST;
    if (opener < floor) {
      return { ok: false, opener: null, reason: `lowball_below_${Math.round(LOWBALL_FLOOR_PCT_OF_LIST * 100)}pct_of_list — opener $${opener.toLocaleString()} < floor $${Math.round(floor).toLocaleString()}; HOLD for operator review` };
    }
    if (opener > input.listPrice) {
      return { ok: false, opener: null, reason: `opener_over_list — $${opener.toLocaleString()} > list $${input.listPrice.toLocaleString()}; corrupted door-opener field` };
    }
  }
  return { ok: true, opener, reason: null };
}

// ── Alert price read (2026-06-10 smoke-test fix) ─────────────────────
// The first Tier 1 smoke test fired the null-price fallback on a record
// that demonstrably had both numbers: the composer read the STICKY
// Outreach_Offer_Price field (which the batch never wrote) instead of the
// resolver chain the batch actually sends from. ONE READ PATH: the alert
// resolves its numbers through resolveOpenerCeiling + openerMaoGuard —
// exactly what the batch dispatches with. Sticky wins when captured;
// MAO_V1 (the door-opener field) is the send-path base otherwise.

export interface AlertNumbers {
  /** The opener we are HOLDING at — sticky if captured, else the guarded
   *  door-opener (the same number the batch would send). Null when the
   *  guard refuses or no base exists (the composer then says "hold sticky
   *  opener" and the gap is audited — never fabricated). */
  opener: number | null;
  /** The underwritten MAO ceiling from the SAME resolver the batch uses. */
  mao: number | null;
}

/** Pure: resolve the {opener, mao} pair for an operator alert through the
 *  batch's own read path. */
export function resolveAlertNumbers(listing: {
  state?: string | null;
  zip?: string | null;
  mao?: number | null;
  outreachOfferPrice?: number | null;
  underwrittenMao?: number | null;
  realArvMedian?: number | null;
  estRehab?: number | null;
  listPrice?: number | null;
  redFlags?: string[] | string | null;
  distressBucket?: string | null;
  distressScore?: number | null;
}): AlertNumbers {
  const ceiling = resolveOpenerCeiling(listing);
  const sticky =
    typeof listing.outreachOfferPrice === "number" && listing.outreachOfferPrice > 0
      ? listing.outreachOfferPrice
      : null;
  const base = sticky ?? (typeof listing.mao === "number" && listing.mao > 0 ? listing.mao : null);
  const guard = openerMaoGuard({ baseOpener: base, mao: ceiling.mao, priceable: ceiling.priceable });
  return { opener: guard.ok ? guard.opener : null, mao: ceiling.mao };
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
