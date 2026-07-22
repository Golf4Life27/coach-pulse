// Per-market rough-opener pricer (Maverick 2026-06-14; LIST-ANCHOR REMOVED
// 2026-06-28, operator ruling). @agent: appraiser/crier
//
// THE COMPOSITION POINT. Produces a conservative, VALUE-ANCHORED opener for
// any market at crawl volume, by routing through the rough ceiling:
//
//   computeRoughOpenerCeiling (lib/rough-opener-ceiling)
//     → buy-box ARV path:  anchor × (ARV×buybox − rehab − fee)   [SEND]
//     → no trusted ARV basis:  NULL ceiling                       [HOLD]
//
// ── THE LIST-FRACTION FALLBACK IS GONE (operator 2026-06-28) ──────────────
// The 2026-06-14 ruling #3 ("the thin/no-ARV opener lands at flat 65% of
// list") is RETIRED. It produced the 18681 Blackmoor catastrophe — a $84.5k
// text = 0.65 × $130k list on a house worth ~$40k. A sight-unseen list
// fraction is anchored to the seller's asking fantasy and routinely over-
// offers 2–3× on distressed/overpriced stock. So when the pricer has no
// trusted ARV value basis, it HOLDS (opener: null) and the record routes to
// operator review. We never text a list-anchored number again. The opener
// is the value-anchored number or it is nothing.
//
// ARV is the ZIP renovated $/sqft (ZIP_ARV_Seed) × the SUBJECT's sqft — it
// prices THE house. A ZIP gets seeded once (one paid comp pull, budget-
// governed); after that every listing in the ZIP prices for free. An un-
// seedable ZIP (no/too-few/too-noisy comps → DONT_PRICE) HOLDS rather than
// guess off list.
//
// COST: napkin math over already-stored / ZIP-seeded comp data — no paid
// call in the hot path. Driveway-rigor (precise contract MAO) lives in the
// reply-triggered re-price, never here.
//
// Pure. No I/O.

import {
  computeRoughOpenerCeiling,
  type RoughCeilingResult,
} from "@/lib/rough-opener-ceiling";
import { anchoredOpenerGate } from "@/lib/h2-outreach/your-mao-opener-gate";
import { computeFlipOffer } from "@/lib/pricing/mao-flip";
import { DEFAULT_WHOLESALE_FEE } from "@/lib/pre-contract-math";

// ── GUARDS (Maverick 2026-06-14, full-437 dry-run outlier review) ──
// The full-437 dry-run exposed holes the old door-opener guarded. These
// remain, all pure — but their fall-through is now a HOLD, never a list
// fraction:
//
//   HOLE A — over-list: a garbage-high stored ARV produced an opener ABOVE
//     asking. NEVER-OVER-LIST CAP clamps the value-anchored opener down to a
//     fraction of list (only ever bites when ARV ≫ list — a deep-discount
//     listing, so the clamp is safe). Flags re-seed on low-confidence ARVs.
//   HOLE B — micro-openers: a tiny-but-positive buy-box ceiling produced an
//     insulting/broken-looking number. LOW-OPENER FLOOR routes sub-floor
//     buy-box openers to a HOLD (operator review), not a list-anchored rail.
//   HOLE C — contaminated stored ARV: Real_ARV_Median often holds AS-IS
//     value (wrong basis), so renovated-ARV < list. ARV-SANITY GATE distrusts
//     any ARV below list and HOLDS (flags re-seed) instead of list-anchoring.

/** Low-opener floor: a buy-box opener below `max(PCT×list, USD)` is treated
 *  as broken-looking and HELD for operator review. Env-tunable.
 *  (NOTE: this now HOLDS rather than routing to a 65%-of-list rail. If cheap-
 *  market volume suffers, lower this to let real low value-anchored openers
 *  send — an operator dial, not a silent default change.) */
export const LOW_OPENER_FLOOR_PCT_OF_LIST = (() => {
  const raw = Number(process.env.LOW_OPENER_FLOOR_PCT_OF_LIST);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.30;
})();
export const LOW_OPENER_FLOOR_USD = (() => {
  const raw = Number(process.env.LOW_OPENER_FLOOR_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
})();

/** The minimum DEFENSIBLE cash opener for a listing: max(PCT×list, $USD).
 *  A buy-box opener below this is a laughable micro-offer (e.g. $1,714 on a
 *  gutted shell) — HOLD → creative/landlord lane, never text it. Exported so
 *  the h2 SEND path applies the identical floor the seed pricer already does
 *  (the relationship-protector the direct send path was missing). Pure given
 *  the env-read constants above. */
export function minOfferFloor(list: number): number {
  return Math.max(LOW_OPENER_FLOOR_PCT_OF_LIST * list, LOW_OPENER_FLOOR_USD);
}

/** Never-over-list cap: the opener can never exceed this fraction of list.
 *  0.85 (operator 2026-07-01) — auto-offer 85% of list on any deal whose
 *  value-anchored opener would come in above it, instead of holding. Set EQUAL
 *  to the >85%-of-list send-safety rail (OFFER_OVER_LIST_BLOCK_PCT in
 *  lib/outreach-economics): the pricer clamps at 85%, so the opener can never
 *  trip that rail and strand the record. KEEP THE TWO ≤ EACH OTHER — an opener
 *  cap above the send rail produces numbers the send path refuses. Env-tunable;
 *  clamped to (0,1] — but a value above the send rail re-opens that gap. */
export const NEVER_OVER_LIST_PCT = (() => {
  const raw = Number(process.env.NEVER_OVER_LIST_PCT);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.85;
})();

export type OpenerBasis =
  | "arv_buybox"          // anchor × (ARV × buy-box − rehab − fee) — the only SEND basis
  | "hold_no_value_basis"; // no trusted ARV basis (or a guard tripped) → HOLD, never list-anchor

/** ARV input confidence, carried for the receipt + the Review-tiering.
 *  STRONG/THIN come from the comp count upstream (≥5 clean comps = STRONG;
 *  <5 = THIN, and the upstream ARV should already be biased to the low end
 *  of the comp range, not the median). STORED = a pre-computed Real_ARV from
 *  the appraiser station (confidence not re-derived here). NONE = held. */
export type OpenerConfidence = "STRONG" | "THIN" | "STORED" | "NONE";

export interface PricerInput {
  listPrice?: number | null;
  /** Rough ARV — stored Real_ARV_Median OR an auto-seeded ZIP $/sqft ×
   *  subject sqft. For THIN comp sets this should already be the low-end
   *  (conservative) figure, not the median. */
  realArvMedian?: number | null;
  estRehabMid?: number | null;
  estRehab?: number | null;
  /** Sourced market buy-box (markets.json arv_pct_max). Absent → HOLD. */
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
  /** The SENT opener — the number the seller would see. Null whenever there
   *  is no trusted ARV value basis (→ the record HOLDS for review). */
  opener: number | null;
  basis: OpenerBasis;
  confidence: OpenerConfidence;
  /** The rough ceiling receipt (buy-box path) — null on a hold. */
  ceiling: number | null;
  ceilingSource: RoughCeilingResult["source"];
  arvUsed: number | null;
  rehabUsed: number | null;
  /** Anchor actually applied (buy-box path only; null on a hold). */
  anchorPct: number | null;
  /** ARV-SANITY GATE (Hole C): stored ARV was below list → distrusted as
   *  wrong-basis (as-is) value and dropped; the record HELD (no list anchor). */
  arvDistrusted: boolean;
  /** This record's ARV is BAD and a re-seed could fix it — a low-confidence
   *  (THIN/STORED/unlabeled) ARV that tripped a guard (below list, or so high
   *  the opener hit the over-list cap). A STRONG renovated seed that trips a
   *  guard is NOT flagged: the seed is trusted, the listing is just deep-
   *  discount (ARV≫list) or over-ARV (ARV<list). */
  flagReseed: boolean;
  /** OVER-ARV LIST cohort tag (operator principle amendment 2026-07-22):
   *  the STRONG-seed value-anchored opener was sent on a listing priced AT
   *  or ABOVE its renovated ARV (ARV < list). The number is still fully
   *  formula-derived — this flag only marks the cohort so reply/conversion
   *  can be tracked and the amendment reversed if it proves noise. */
  overArvList: boolean;
  /** LOW-OPENER FLOOR (Hole B): a buy-box opener fell below the floor and was
   *  HELD for operator review rather than sending a micro-number. */
  flooredToFallback: boolean;
  /** NEVER-OVER-LIST CAP (Hole A): the value-anchored opener exceeded list and
   *  was clamped down to a fraction of list (safe — only bites when ARV≫list). */
  cappedToList: boolean;
  /** MAO BOUND (Hole D, operator 2026-07-16): the flip-lane seller offer
   *  (0.70×ARV − rehab − closing − fee) computed from the SAME ARV/rehab this
   *  opener used. The opener NEVER exceeds it — the first offer can never sit
   *  above your maximum. Null only on a hold. */
  maoBound: number | null;
  /** True when the anchored opener exceeded maoBound and was clamped to it. */
  boundedToMao: boolean;
  detail: string;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** HOLD result — no trusted value basis (or a guard tripped), so NO autonomous
 *  opener. The opener is null and the record routes to operator review. This
 *  REPLACES the retired flat-65%-of-list fallback (operator 2026-06-28): we
 *  never text a number anchored to the seller's list price. */
function holdResult(
  ceilingSource: RoughCeilingResult["source"],
  detail: string,
  extra?: Partial<Pick<PricerResult, "arvDistrusted" | "flagReseed" | "flooredToFallback">>,
): PricerResult {
  return {
    opener: null,
    basis: "hold_no_value_basis",
    confidence: "NONE",
    ceiling: null,
    ceilingSource,
    arvUsed: null,
    rehabUsed: null,
    anchorPct: null,
    arvDistrusted: extra?.arvDistrusted ?? false,
    flagReseed: extra?.flagReseed ?? false,
    overArvList: false,
    flooredToFallback: extra?.flooredToFallback ?? false,
    cappedToList: false,
    maoBound: null,
    boundedToMao: false,
    detail,
  };
}

/** Pure: produce a conservative, GUARDED, VALUE-ANCHORED opener for a single
 *  listing — or a HOLD. Guard order: ARV-sanity gate → base price → low-opener
 *  floor → over-list cap. A broken-looking number (over list, a sub-floor
 *  micro-opener, or a no-value-basis record) never sends — it HOLDS. */
export function priceOpener(input: PricerInput): PricerResult {
  const list = pos(input.listPrice) ? input.listPrice : null;
  const rawArv = pos(input.realArvMedian) ? input.realArvMedian : null;

  // ── GUARD: ARV-SANITY GATE (Hole C) — CONFIDENCE-AWARE ──
  // (Operator principle amendment 2026-07-22, superseding the 2026-06-28
  // blanket hold.) ARV < list has two distinct causes:
  //   THIN/STORED/unlabeled ARV → probably a wrong-basis (as-is) value.
  //     Distrust it and HOLD, flag re-seed. Unchanged.
  //   STRONG seed (≥5 tight renovated comps) → the seed is trusted; the
  //     LISTING is over-ARV — which is precisely why it aged into the
  //     tier-8 funnel. The value-anchored opener SENDS (list price is not
  //     an input to the formula, so the Blackmoor failure mode cannot
  //     recur), tagged over_arv_list so the cohort's reply/conversion is
  //     trackable and the amendment reversible on evidence.
  // Production receipt for the amendment: 2026-07-22 dry run held 48/50 of
  // the scanned send queue on this gate alone.
  const arvBelowList = rawArv != null && list != null && rawArv < list;
  const overArvList = arvBelowList && input.arvConfidence === "STRONG";
  if (arvBelowList && list != null && !overArvList) {
    return holdResult(
      "hold_no_value_basis",
      `renovated ARV $${rawArv!.toLocaleString()} < list $${list.toLocaleString()} — distrusted as wrong-basis (as-is) value ` +
        `(confidence ${input.arvConfidence ?? "unlabeled"}); HELD for operator review (never list-anchored), flagged for re-seed`,
      { arvDistrusted: true, flagReseed: true },
    );
  }
  const trustedArv = rawArv;

  const rough = computeRoughOpenerCeiling({
    realArvMedian: trustedArv,
    estRehabMid: input.estRehabMid ?? null,
    estRehab: input.estRehab ?? null,
    listPrice: input.listPrice ?? null,
    arvPctMax: input.arvPctMax ?? null,
    wholesaleFee: input.wholesaleFee ?? null,
  });

  // ── BUY-BOX ARV PATH ── the ONLY path that produces a sent opener. Ceiling
  // from a trusted ARV + sourced buy-box.
  if (rough.source === "rough_buybox_arv" || rough.source === "rough_buybox_arv_placeholder_rehab") {
    const gate = anchoredOpenerGate({ ceiling: rough.ceiling, anchorPct: input.anchorPct ?? null, priceable: true });
    const confidence: OpenerConfidence =
      input.arvConfidence === "STRONG" ? "STRONG"
      : input.arvConfidence === "THIN" ? "THIN"
      : "STORED";

    // ── GUARD: MAO BOUND (Hole D, operator 2026-07-16) ── the opener can
    // NEVER exceed the flip-lane seller offer (0.70×ARV − rehab − closing −
    // fee) computed from the SAME ARV/rehab the ceiling used. Before this,
    // the opener rode a looser market buy-box and an 85%-of-LIST clamp, so
    // the FIRST text could sit ABOVE your own maximum (all 7 underwater
    // deals — Forest Manor opened $97,665 against a $78,886 MAO). One
    // formula, cold-touch through contract: lib/pricing/mao-flip.
    const fee = pos(input.wholesaleFee) ? input.wholesaleFee : DEFAULT_WHOLESALE_FEE;
    const flip = computeFlipOffer({ arv: trustedArv, rehab: rough.rehabUsed, assignmentFee: fee });
    if (flip.status === "no_deal" || flip.offer == null || flip.offer <= 0) {
      return holdResult(
        rough.source,
        `does not pencil as a flip — MAO bound ≤ $0 (0.70×ARV $${(trustedArv ?? 0).toLocaleString()} − rehab $${(rough.rehabUsed ?? 0).toLocaleString()} − closing − fee $${fee.toLocaleString()}). ` +
          `HELD for operator review (rental/creative lane candidate; never list-anchored)`,
      );
    }
    const maoBound = flip.offer;

    if (gate.ok && gate.opener != null) {
      const boundedToMao = gate.opener > maoBound;
      const opener = boundedToMao ? maoBound : gate.opener;
      // ── GUARD: LOW-OPENER FLOOR (Hole B) ── a tiny-but-positive ceiling
      // yields a broken-looking micro-opener. Below max(PCT×list, USD) → HOLD
      // for operator review instead of sending it (and instead of the retired
      // list-fraction rail).
      if (list != null) {
        const floor = minOfferFloor(list);
        if (opener < floor) {
          return holdResult(
            rough.source,
            `buy-box opener $${opener.toLocaleString()} below floor $${Math.round(floor).toLocaleString()} ` +
              `(max ${Math.round(LOW_OPENER_FLOOR_PCT_OF_LIST * 100)}%×list, $${LOW_OPENER_FLOOR_USD.toLocaleString()}) — ` +
              `micro-opener suppressed, HELD for operator review`,
            { flooredToFallback: true },
          );
        }
      }
      return applyOverListCap(
        {
          opener,
          basis: "arv_buybox",
          confidence,
          ceiling: rough.ceiling,
          ceilingSource: rough.source,
          arvUsed: rough.arvUsed,
          rehabUsed: rough.rehabUsed,
          anchorPct: gate.anchorPct,
          arvDistrusted: false,
          flagReseed: false,
          overArvList,
          flooredToFallback: false,
          cappedToList: false,
          maoBound,
          boundedToMao,
          detail:
            `${gate.detail} [${confidence}] (${rough.detail})` +
            (boundedToMao
              ? ` | BOUNDED to MAO $${maoBound.toLocaleString()} (anchored opener $${gate.opener.toLocaleString()} exceeded the flip-lane max — the first offer never sits above your MAO)`
              : ` | MAO bound $${maoBound.toLocaleString()} ok`) +
            (overArvList
              ? ` | OVER_ARV_LIST cohort: STRONG seed ARV $${(rough.arvUsed ?? 0).toLocaleString()} < list $${(list ?? 0).toLocaleString()} — value-anchored lowball sent per 2026-07-22 amendment`
              : ""),
        },
        list,
      );
    }
    // Buy-box ceiling did not pencil (≤0 — rehab ate the value) → HOLD. A non-
    // deal correctly holds; we never paper over it with a list fraction.
    return holdResult(
      rough.source,
      `buy-box ceiling did not pencil (${gate.reason}) — HELD for operator review (rehab eats the buy-box; never list-anchored)`,
    );
  }

  // ── NO TRUSTED ARV VALUE BASIS ── HOLD. The retired path here was the flat
  // 65%-of-list fallback; it is gone (operator 2026-06-28). Without a value
  // anchor we do not text the seller a number — the record routes to review.
  return holdResult(
    rough.source,
    `no trusted ARV value basis (no ZIP $/sqft seed × sqft, no sourced buy-box) — ` +
      `HELD for operator review (the list-fraction fallback is retired; never list-anchored)`,
  );
}

/** GUARD: NEVER-OVER-LIST CAP (Hole A). The value-anchored opener can never
 *  exceed NEVER_OVER_LIST_PCT × list (0.85 — auto-offer 85%, operator
 *  2026-07-01). The cap only bites when the buy-box opener exceeds it, i.e.
 *  ARV ≫ list (a deep-discount listing), so clamping to a fraction of list is
 *  safe here — it is NOT the retired list-anchored fallback (that fired with NO
 *  value basis). FLOOR (not round) the cap: a "never OVER x%" clamp must never
 *  round UP past x% — that would put the offer above the equal >85% send rail
 *  and get it refused. When the cap bites on a low-confidence ARV, flag re-seed. */
function applyOverListCap(r: PricerResult, list: number | null): PricerResult {
  if (list == null || r.opener == null) return r;
  const cap = Math.floor(list * NEVER_OVER_LIST_PCT);
  if (r.opener <= cap) return r;
  const reseedWorthy = r.confidence !== "STRONG";
  return {
    ...r,
    opener: cap,
    cappedToList: true,
    flagReseed: reseedWorthy,
    detail: `${r.detail} | CAPPED to ${Math.round(NEVER_OVER_LIST_PCT * 100)}% of list = $${cap.toLocaleString()} (value-anchored opener exceeded the cap — ` +
      (reseedWorthy
        ? `ARV implausibly high, flagged for re-seed)`
        : `deep-discount listing: renovated ARV ≫ list, seed trusted (STRONG) — capped, not re-seeded)`),
  };
}
