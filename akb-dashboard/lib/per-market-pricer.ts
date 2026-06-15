// Per-market rough-opener pricer (Maverick 2026-06-14, national-crawler
// build — HALF 1). @agent: appraiser/crier
//
// THE COMPOSITION POINT. Produces a conservative opener number for ANY
// market, at crawl volume, by routing through the rails already ruled on —
// no parallel pricing engine:
//
//   computeRoughOpenerCeiling (lib/rough-opener-ceiling)
//     → buy-box ARV path:  anchor × (ARV×buybox − rehab − fee)
//     → thin/no-ARV path:   FLAT 65%-of-list (anchor-INDEPENDENT)
//
// RULING #3 (Maverick 2026-06-14): in the thin-data / no-ARV case the SENT
// opener — the number the seller sees — must land at ≈65% of list. The old
// path multiplied a 0.72 list-fraction ceiling by the 0.90 anchor (≈0.65),
// which only holds while the anchor is 0.90; a calibrated-down market would
// drift to 57%. So the fallback here is a FLAT 65% of list, applied AFTER
// (independent of) the anchor. The anchor governs only the ARV buy-box
// opener, where it is a fraction of the penciling ceiling.
//
// NATIONAL DOCTRINE (decoupled from the old seeded-median "priceable"
// gate): the fallback opener requires only a list price — a brand-new,
// un-seeded market produces its conservative opener on day one. The SEND
// decision (auto-promote vs Review, per-market) lives downstream, NOT here.
// The ARV buy-box path needs only a sourced arv_pct_max + an ARV (stored or
// auto-seeded) — it does NOT need a buyer median. This pricer never HOLDs as
// long as a list price exists; "never hold — always produce a number."
//
// COST: this is napkin math over already-stored / ZIP-seeded comp data — no
// paid call in the hot path. Driveway-rigor (precise contract MAO) lives in
// the reply-triggered re-price, never here.
//
// Pure. No I/O.

import {
  computeRoughOpenerCeiling,
  type RoughCeilingResult,
} from "@/lib/rough-opener-ceiling";
import { anchoredOpenerGate } from "@/lib/h2-outreach/your-mao-opener-gate";

/** The flat list fraction the SENT opener lands on when comps are thin or
 *  absent (Maverick ruling #3 — the seller-facing number ≈65% of list).
 *  Anchor-independent. Env-tunable; clamped to a sane (0,1]. */
export const FALLBACK_OPENER_PCT_OF_LIST = (() => {
  const raw = Number(process.env.FALLBACK_OPENER_PCT_OF_LIST);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.65;
})();

// ── GUARDS (Maverick 2026-06-14, full-437 dry-run outlier review) ──
// The full-437 dry-run exposed three holes the old door-opener guarded and
// the new pricer had dropped. These restore them, all pure:
//
//   HOLE A — over-list: a garbage-high stored ARV produced an opener ABOVE
//     asking ($87,891 on a $47,900 list). NEVER-OVER-LIST CAP fixes it.
//   HOLE B — micro-openers: a tiny-but-positive buy-box ceiling produced
//     insulting numbers ($115 on a $35k house). LOW-OPENER FLOOR routes
//     sub-floor buy-box openers to the clean 65% rail instead of sending a
//     broken-looking number.
//   HOLE C — contaminated stored ARV: Real_ARV_Median often holds AS-IS
//     value (wrong basis), so renovated-ARV < list. ARV-SANITY GATE
//     distrusts any ARV below list, drops to the 65% fallback, and flags the
//     record for re-seed (auto-seed replaces it with renovated-comp $/sqft).

/** Low-opener floor: a buy-box opener below `max(PCT×list, USD)` is treated
 *  as broken-looking and routed to the flat 65% rail. Env-tunable. */
export const LOW_OPENER_FLOOR_PCT_OF_LIST = (() => {
  const raw = Number(process.env.LOW_OPENER_FLOOR_PCT_OF_LIST);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.30;
})();
export const LOW_OPENER_FLOOR_USD = (() => {
  const raw = Number(process.env.LOW_OPENER_FLOOR_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
})();

/** Never-over-list cap: the opener can never exceed this fraction of list.
 *  0.90 (Maverick 2026-06-14) leaves negotiating room on strong deals
 *  instead of opening at asking. Env-tunable; clamped to (0,1]. */
export const NEVER_OVER_LIST_PCT = (() => {
  const raw = Number(process.env.NEVER_OVER_LIST_PCT);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.90;
})();

export type OpenerBasis =
  | "arv_buybox"        // anchor × (ARV × buy-box − rehab − fee)
  | "list_fraction_65"  // flat 65%-of-list fallback (thin/no ARV)
  | "hold_no_inputs";   // no ARV and no list — genuinely nothing

/** ARV input confidence, carried for the receipt + the Review-tiering.
 *  STRONG/THIN come from the comp count upstream (≥5 clean comps = STRONG;
 *  <5 = THIN, and the upstream ARV should already be biased to the low end
 *  of the comp range, not the median). STORED = a pre-computed Real_ARV from
 *  the appraiser station (confidence not re-derived here). */
export type OpenerConfidence = "STRONG" | "THIN" | "STORED" | "FALLBACK" | "NONE";

export interface PricerInput {
  listPrice?: number | null;
  /** Rough ARV — stored Real_ARV_Median OR an auto-seeded ZIP $/sqft ×
   *  subject sqft. For THIN comp sets this should already be the low-end
   *  (conservative) figure, not the median. */
  realArvMedian?: number | null;
  estRehabMid?: number | null;
  estRehab?: number | null;
  /** Sourced market buy-box (markets.json arv_pct_max). Absent → fallback. */
  arvPctMax?: number | null;
  wholesaleFee?: number | null;
  /** Effective per-market anchor (lib/markets/anchor.resolveAnchorPct).
   *  Used ONLY on the ARV buy-box path. */
  anchorPct?: number | null;
  /** Confidence of the supplied ARV (from comp count upstream). Drives the
   *  receipt label; STRONG/THIN/STORED only meaningful on the buy-box path. */
  arvConfidence?: "STRONG" | "THIN" | null;
}

export interface PricerResult {
  /** The SENT opener — the number the seller would see. Null only when there
   *  is no ARV AND no list price (genuinely nothing to price). */
  opener: number | null;
  basis: OpenerBasis;
  confidence: OpenerConfidence;
  /** The rough ceiling receipt (buy-box path) — null/echoed for fallback. */
  ceiling: number | null;
  ceilingSource: RoughCeilingResult["source"];
  arvUsed: number | null;
  rehabUsed: number | null;
  /** Anchor actually applied (buy-box path only; null on the flat fallback). */
  anchorPct: number | null;
  /** ARV-SANITY GATE (Hole C): stored ARV was below list → distrusted as
   *  wrong-basis (as-is) value and dropped; the opener used the 65% rail. */
  arvDistrusted: boolean;
  /** This record's stored ARV proved untrustworthy (below list, OR so high
   *  the opener hit the over-list cap) — flag it for auto-seed re-pricing. */
  flagReseed: boolean;
  /** LOW-OPENER FLOOR (Hole B): a buy-box opener fell below the floor and
   *  was routed to the 65% rail rather than sending a micro-number. */
  flooredToFallback: boolean;
  /** NEVER-OVER-LIST CAP (Hole A): the opener exceeded list and was clamped
   *  down to the list price. */
  cappedToList: boolean;
  detail: string;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Flat 65%-of-list fallback result (anchor-independent). Shared by the
 *  thin/no-ARV path AND the floor/sanity fall-throughs. */
function fallbackResult(
  list: number,
  ceilingSource: RoughCeilingResult["source"],
  detail: string,
): PricerResult {
  return {
    opener: Math.round(list * FALLBACK_OPENER_PCT_OF_LIST),
    basis: "list_fraction_65",
    confidence: "FALLBACK",
    ceiling: null,
    ceilingSource,
    arvUsed: null,
    rehabUsed: null,
    anchorPct: null,
    arvDistrusted: false,
    flagReseed: false,
    flooredToFallback: false,
    cappedToList: false,
    detail,
  };
}

/** Pure: produce a conservative, GUARDED opener for a single listing.
 *  Guard order: ARV-sanity gate → base price → low-opener floor → over-list
 *  cap. A broken-looking number (over list, or a sub-floor micro-opener)
 *  never leaves this function. */
export function priceOpener(input: PricerInput): PricerResult {
  const list = pos(input.listPrice) ? input.listPrice : null;
  const rawArv = pos(input.realArvMedian) ? input.realArvMedian : null;

  // ── GUARD: ARV-SANITY GATE (Hole C) ── a renovated ARV below the asking
  // price is implausible — it's as-is (wrong-basis) value. Distrust it:
  // treat the record as no-ARV (→ 65% rail) and flag it for re-seed.
  const arvDistrusted = rawArv != null && list != null && rawArv < list;
  const trustedArv = arvDistrusted ? null : rawArv;

  if (arvDistrusted && list != null) {
    const r = fallbackResult(
      list,
      "list_fraction_no_arv",
      `stored ARV $${rawArv!.toLocaleString()} < list $${list.toLocaleString()} — distrusted as wrong-basis (as-is) value; ` +
        `dropped to flat ${Math.round(FALLBACK_OPENER_PCT_OF_LIST * 100)}% of list = $${Math.round(list * FALLBACK_OPENER_PCT_OF_LIST).toLocaleString()}, flagged for re-seed`,
    );
    r.arvDistrusted = true;
    r.flagReseed = true;
    return applyOverListCap(r, list);
  }

  const rough = computeRoughOpenerCeiling({
    realArvMedian: trustedArv,
    estRehabMid: input.estRehabMid ?? null,
    estRehab: input.estRehab ?? null,
    listPrice: input.listPrice ?? null,
    arvPctMax: input.arvPctMax ?? null,
    wholesaleFee: input.wholesaleFee ?? null,
  });

  // ── BUY-BOX ARV PATH ── ceiling from a trusted ARV + sourced buy-box.
  if (rough.source === "rough_buybox_arv" || rough.source === "rough_buybox_arv_placeholder_rehab") {
    const gate = anchoredOpenerGate({ ceiling: rough.ceiling, anchorPct: input.anchorPct ?? null, priceable: true });
    const confidence: OpenerConfidence =
      input.arvConfidence === "STRONG" ? "STRONG"
      : input.arvConfidence === "THIN" ? "THIN"
      : "STORED";

    if (gate.ok && gate.opener != null) {
      // ── GUARD: LOW-OPENER FLOOR (Hole B) ── a tiny-but-positive ceiling
      // yields a broken-looking micro-opener. Below max(PCT×list, USD) →
      // route to the clean 65% rail instead of sending it.
      if (list != null) {
        const floor = Math.max(LOW_OPENER_FLOOR_PCT_OF_LIST * list, LOW_OPENER_FLOOR_USD);
        if (gate.opener < floor) {
          const r = fallbackResult(
            list,
            rough.source,
            `buy-box opener $${gate.opener.toLocaleString()} below floor $${Math.round(floor).toLocaleString()} ` +
              `(max ${Math.round(LOW_OPENER_FLOOR_PCT_OF_LIST * 100)}%×list, $${LOW_OPENER_FLOOR_USD.toLocaleString()}) — ` +
              `micro-opener suppressed, routed to flat ${Math.round(FALLBACK_OPENER_PCT_OF_LIST * 100)}% of list`,
          );
          r.flooredToFallback = true;
          return applyOverListCap(r, list);
        }
      }
      return applyOverListCap(
        {
          opener: gate.opener,
          basis: "arv_buybox",
          confidence,
          ceiling: rough.ceiling,
          ceilingSource: rough.source,
          arvUsed: rough.arvUsed,
          rehabUsed: rough.rehabUsed,
          anchorPct: gate.anchorPct,
          arvDistrusted: false,
          flagReseed: false,
          flooredToFallback: false,
          cappedToList: false,
          detail: `${gate.detail} [${confidence}] (${rough.detail})`,
        },
        list,
      );
    }
    // Buy-box ceiling didn't pencil (≤0) — fall to the 65% rail, never hold
    // while a list exists.
    if (list != null) {
      const r = fallbackResult(
        list,
        rough.source,
        `buy-box ceiling did not pencil (${gate.reason}) — fell back to flat ${Math.round(FALLBACK_OPENER_PCT_OF_LIST * 100)}% of list`,
      );
      return applyOverListCap(r, list);
    }
    return {
      opener: null, basis: "hold_no_inputs", confidence: "NONE",
      ceiling: rough.ceiling, ceilingSource: rough.source, arvUsed: rough.arvUsed, rehabUsed: rough.rehabUsed,
      anchorPct: null, arvDistrusted: false, flagReseed: false, flooredToFallback: false, cappedToList: false,
      detail: `buy-box ceiling did not pencil (${gate.reason}) and no list price — opener holds`,
    };
  }

  // ── FLAT 65%-OF-LIST FALLBACK ── thin/no (trusted) ARV.
  if (list != null) {
    return fallbackResult(
      list,
      rough.source,
      `flat ${Math.round(FALLBACK_OPENER_PCT_OF_LIST * 100)}% of list $${list.toLocaleString()} ` +
        `= $${Math.round(list * FALLBACK_OPENER_PCT_OF_LIST).toLocaleString()} (thin/no ARV — conservative, anchor-independent)`,
    );
  }

  // No ARV and no list — the rare genuine hold.
  return {
    opener: null, basis: "hold_no_inputs", confidence: "NONE",
    ceiling: null, ceilingSource: rough.source, arvUsed: null, rehabUsed: null,
    anchorPct: null, arvDistrusted: false, flagReseed: false, flooredToFallback: false, cappedToList: false,
    detail: "no ARV and no list price — opener cannot be computed",
  };
}

/** GUARD: NEVER-OVER-LIST CAP (Hole A). The opener can never exceed
 *  NEVER_OVER_LIST_PCT × list (0.90 — leaves negotiating room on strong
 *  deals). When the cap bites, the stored ARV was implausibly high → flag
 *  re-seed. */
function applyOverListCap(r: PricerResult, list: number | null): PricerResult {
  if (list == null || r.opener == null) return r;
  const cap = Math.round(list * NEVER_OVER_LIST_PCT);
  if (r.opener <= cap) return r;
  return {
    ...r,
    opener: cap,
    cappedToList: true,
    flagReseed: true,
    detail: `${r.detail} | CAPPED to ${Math.round(NEVER_OVER_LIST_PCT * 100)}% of list = $${cap.toLocaleString()} (opener exceeded the cap — stored ARV implausibly high, flagged for re-seed)`,
  };
}
