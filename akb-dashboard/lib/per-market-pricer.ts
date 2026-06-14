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
  detail: string;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Pure: produce a conservative opener for a single listing. */
export function priceOpener(input: PricerInput): PricerResult {
  const rough = computeRoughOpenerCeiling({
    realArvMedian: input.realArvMedian ?? null,
    estRehabMid: input.estRehabMid ?? null,
    estRehab: input.estRehab ?? null,
    listPrice: input.listPrice ?? null,
    arvPctMax: input.arvPctMax ?? null,
    wholesaleFee: input.wholesaleFee ?? null,
  });

  // ── BUY-BOX ARV PATH ── ceiling came from a real ARV + sourced buy-box.
  // The anchor (a fraction of the penciling ceiling) sets the opener.
  if (rough.source === "rough_buybox_arv" || rough.source === "rough_buybox_arv_placeholder_rehab") {
    const gate = anchoredOpenerGate({
      ceiling: rough.ceiling,
      anchorPct: input.anchorPct ?? null,
      // The pricer only reaches this branch when ARV pricing is available
      // for the record; the old seeded-median market gate is enforced
      // downstream, not here.
      priceable: true,
    });
    const confidence: OpenerConfidence =
      input.arvConfidence === "STRONG" ? "STRONG"
      : input.arvConfidence === "THIN" ? "THIN"
      : "STORED";

    if (gate.ok && gate.opener != null) {
      return {
        opener: gate.opener,
        basis: "arv_buybox",
        confidence,
        ceiling: rough.ceiling,
        ceilingSource: rough.source,
        arvUsed: rough.arvUsed,
        rehabUsed: rough.rehabUsed,
        anchorPct: gate.anchorPct,
        detail: `${gate.detail} [${confidence}] (${rough.detail})`,
      };
    }
    // Buy-box ceiling didn't pencil (≤0: rehab ate the buy-box) or anchor
    // invalid. Fall THROUGH to the flat list fallback rather than holding —
    // a thin conservative number beats a hold, and list always exists.
    if (pos(input.listPrice)) {
      const opener = Math.round(input.listPrice * FALLBACK_OPENER_PCT_OF_LIST);
      return {
        opener,
        basis: "list_fraction_65",
        confidence: "FALLBACK",
        ceiling: rough.ceiling,
        ceilingSource: rough.source,
        arvUsed: rough.arvUsed,
        rehabUsed: rough.rehabUsed,
        anchorPct: null,
        detail:
          `buy-box ceiling did not pencil (${gate.reason}) — fell back to flat ` +
          `${Math.round(FALLBACK_OPENER_PCT_OF_LIST * 100)}% of list $${input.listPrice.toLocaleString()} = $${opener.toLocaleString()}`,
      };
    }
    // No list to fall back to — genuinely nothing.
    return {
      opener: null,
      basis: "hold_no_inputs",
      confidence: "NONE",
      ceiling: rough.ceiling,
      ceilingSource: rough.source,
      arvUsed: rough.arvUsed,
      rehabUsed: rough.rehabUsed,
      anchorPct: null,
      detail: `buy-box ceiling did not pencil (${gate.reason}) and no list price — opener holds`,
    };
  }

  // ── FLAT 65%-OF-LIST FALLBACK ── thin/no ARV. Anchor-independent: the
  // SENT number is FALLBACK_OPENER_PCT_OF_LIST × list (ruling #3).
  if (pos(input.listPrice)) {
    const opener = Math.round(input.listPrice * FALLBACK_OPENER_PCT_OF_LIST);
    return {
      opener,
      basis: "list_fraction_65",
      confidence: "FALLBACK",
      ceiling: null,
      ceilingSource: rough.source, // "list_fraction_no_arv" (or hold→handled below)
      arvUsed: null,
      rehabUsed: null,
      anchorPct: null,
      detail:
        `flat ${Math.round(FALLBACK_OPENER_PCT_OF_LIST * 100)}% of list $${input.listPrice.toLocaleString()} ` +
        `= $${opener.toLocaleString()} (thin/no ARV — conservative, anchor-independent)`,
    };
  }

  // No ARV and no list — the rare genuine hold.
  return {
    opener: null,
    basis: "hold_no_inputs",
    confidence: "NONE",
    ceiling: null,
    ceilingSource: rough.source,
    arvUsed: null,
    rehabUsed: null,
    anchorPct: null,
    detail: "no ARV and no list price — opener cannot be computed",
  };
}
