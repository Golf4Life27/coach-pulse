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
  ROUGH_REHAB_PCT_OF_ARV,
  type RoughCeilingResult,
} from "@/lib/rough-opener-ceiling";
import {
  PLACEHOLDER_REHAB_SOURCE,
  PLACEHOLDER_REHAB_HOLD_REASON,
} from "@/lib/pricing/vision-queue";
import { anchoredOpenerGate } from "@/lib/h2-outreach/your-mao-opener-gate";
import { computeFlipOffer } from "@/lib/pricing/mao-flip";
import { DEFAULT_WHOLESALE_FEE, effectiveWholesaleFee } from "@/lib/pre-contract-math";

// ── GUARDS (Maverick 2026-06-14, full-437 dry-run outlier review) ──
// The full-437 dry-run exposed holes the old door-opener guarded. These
// remain, all pure — but their fall-through is now a HOLD, never a list
// fraction:
//
//   HOLE A — over-list: a garbage-high stored ARV produced an opener ABOVE
//     asking. OVER-LIST TRIPWIRE (Option B, ruling recmy2Vwp1wMA1Vs8): the
//     record HOLDS and surfaces (Type 2C) — deep discount or broken inputs,
//     the operator decides. The old clamp-to-0.85×list PRODUCER is retired
//     (2026-07-27): it laundered inflated ARVs into confident list-anchored
//     texts (533 Robison, 1122 West Ave). Flags re-seed on low-confidence ARVs.
//   HOLE B — micro-openers: a tiny-but-positive buy-box ceiling produced an
//     insulting/broken-looking number. LOW-OPENER FLOOR routes sub-floor
//     buy-box openers to a HOLD (operator review), not a list-anchored rail.
//   HOLE C — contaminated stored ARV: Real_ARV_Median often holds AS-IS
//     value (wrong basis), so renovated-ARV < list. ARV-SANITY GATE distrusts
//     any ARV below list and HOLDS (flags re-seed) instead of list-anchoring.

/** Low-opener floor — VALUE-ANCHORED (operator 2026-08-07).
 *
 *  WAS max(30% × LIST, $10,000), and that was the last list-anchored term left
 *  in the pricer. The doctrine is that the seller's ask is NEVER an input to
 *  our number; a floor expressed as a fraction of the ask violates it in the
 *  one place it does the most damage, because an inflated ask RAISES the bar
 *  our correctly-computed offer has to clear.
 *
 *  MEASURED, 14 live Detroit records through the shipped pricer: 7 held here.
 *  Every one of the 7 was asking AT OR ABOVE its own fully-renovated value
 *  (ARV 57-96% of list) — so 30% of that ask was 30% of a fiction. 16172 Cruse
 *  computed $31,000, which IS its MAO to the dollar, and was suppressed for
 *  missing a $32,700 bar set by a seller who wants $109,000 for a house worth
 *  $104,328 finished. Meanwhile all 7 openers sat at 25-31% OF ARV — right
 *  where a healthy cheap-market deal lands (0.6461×ARV − 0.30×ARV − $5k fee
 *  ≈ 30% of ARV). They were never broken numbers. They were correct numbers
 *  measured against the wrong stick.
 *
 *  The floor's real job — never text a laughable micro-offer like $1,714 on a
 *  gutted shell — is preserved by measuring against VALUE and by the absolute
 *  dollar backstop, which is unchanged. 15% of ARV is half of where a normal
 *  deal lands, so it still catches genuinely broken arithmetic. */
export const LOW_OPENER_FLOOR_PCT_OF_ARV = (() => {
  const raw = Number(process.env.LOW_OPENER_FLOOR_PCT_OF_ARV);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.15;
})();
/** The ABSURDITY rail — see minOfferFloor. Lowered 0.30 → 0.15 (2026-08-07).
 *  This is a send/don't-send politeness bound, NOT a pricing input: it can
 *  only ever suppress a number, never produce or raise one. */
export const LOW_OPENER_FLOOR_PCT_OF_LIST = (() => {
  const raw = Number(process.env.LOW_OPENER_FLOOR_PCT_OF_LIST);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.15;
})();
export const LOW_OPENER_FLOOR_USD = (() => {
  const raw = Number(process.env.LOW_OPENER_FLOOR_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
})();

/** The minimum DEFENSIBLE cash opener:
 *      max(PCT_OF_ARV × ARV, PCT_OF_LIST × list, $USD)
 *
 *  THE FLOOR DOES TWO DIFFERENT JOBS and the old single 30%-of-list term
 *  conflated them, which is why it was both too strict and too loose:
 *
 *   (1) BROKEN ARITHMETIC — the ceiling pencilled to a nonsense micro-number
 *       ($1,714 on a gutted shell). Detected against VALUE, because that is
 *       what "broken" is relative to. A healthy cheap-market opener lands near
 *       0.6461×ARV − 0.30×ARV − $5k ≈ 30% of ARV, so 15% is half of normal.
 *
 *   (2) ABSURD VS THE ASK — arithmetically fine but so far under the seller's
 *       number that texting it burns the agent. Inherently list-relative;
 *       nothing about ARV can detect it.
 *
 *  Job (2) at 30% of list was suppressing correct offers wholesale. Measured
 *  on 14 live Detroit records: 7 held, all of them asking AT OR ABOVE their own
 *  renovated value, so 30% of that ask was 30% of a fiction. 16172 Cruse
 *  computed $31,000 — its MAO to the dollar, 30% of ARV — and was blocked for
 *  missing a $32,700 bar by $1,700. The 7 sit at 16-28% of ask and 25-31% of
 *  ARV. The pathological case that job (2) exists for looks nothing like them:
 *  ARV $60,000 against a $200,000 ask is an opener at 7% of list.
 *
 *  So both terms stay, and the list term drops to 15% — low enough to clear
 *  every correctly-priced record measured, high enough to still catch the 7%
 *  case. The ask remains barred from PRODUCING a number; it may only veto one.
 *
 *  Exported so the h2 SEND path and email-recovery apply the identical floor
 *  the seed pricer does. Pure given the env-read constants above. */
export function minOfferFloor(list: number, arv?: number | null): number {
  const valueFloor =
    typeof arv === "number" && Number.isFinite(arv) && arv > 0
      ? LOW_OPENER_FLOOR_PCT_OF_ARV * arv
      : 0;
  return Math.max(valueFloor, LOW_OPENER_FLOOR_PCT_OF_LIST * list, LOW_OPENER_FLOOR_USD);
}

/** Over-list TRIPWIRE threshold: an opener above this fraction of list HOLDS
 *  for operator review (Type 2C) — it is never clamped to this figure and
 *  never sent (the "auto-offer 85% of list" producer of 2026-07-01 is retired,
 *  ruling recmy2Vwp1wMA1Vs8 / operator 2026-07-27: "no value in it"). Kept
 *  EQUAL to the >85%-of-list send-safety rail (OFFER_OVER_LIST_BLOCK_PCT in
 *  lib/outreach-economics) so every opener that passes the tripwire also
 *  clears the send rail. Env-tunable; clamped to (0,1]. */
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
  /** Subject square footage — feeds the scope-tiered rehab fallback when there
   *  is no vision read. Without it such a record still HOLDS. */
  sqft?: number | null;
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
  /** TRUE when rehabUsed is a ROUGH_REHAB_PCT_OF_ARV guess rather than a
   *  vision read (256 Westchester, 2026-07-31). The opener is arithmetically
   *  valid but its largest term after ARV was invented, so it must not reach
   *  a seller — the send paths convert this to a HOLD and route the record to
   *  the vision queue. Carried as a flag rather than an early hold so every
   *  downstream diagnostic still runs and keeps its own, more specific reason. */
  placeholderRehab?: boolean;
  /** Named scope when rehab came from sqft × a scope tier instead of a vision
   *  read — drives the "which scope is it?" ask in the outbound message. */
  assumedScope?: "light" | "medium" | "heavy" | null;
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
  /** NEVER-OVER-LIST CAP — RETIRED AS A PRODUCER (operator ruling
   *  recmy2Vwp1wMA1Vs8 2026-07-06; producer path killed 2026-07-27 after
   *  533 Robison $29,750 / 1122 West Ave $110,499). Permanently false: the
   *  pricer never substitutes a list fraction for the derived opener. Kept
   *  only so legacy receipts/displays keep compiling. */
  cappedToList: boolean;
  /** OVER-LIST TRIPWIRE (Hole A, Option B semantics): the value-anchored
   *  opener exceeded NEVER_OVER_LIST_PCT × list — either a genuine deep-
   *  discount listing or broken inputs (an inflated ARV: the Avon, hot-pocket
   *  seed, and Robison portfolio-deed classes). Both belong to the operator:
   *  the record HOLDS and surfaces (Type 2C) with the computed number in
   *  `detail`. The threshold never produces, clamps, or modifies a number. */
  overListTripwire: boolean;
  /** MAO BOUND (Hole D, operator 2026-07-16): the flip-lane seller offer
   *  (0.70×ARV − rehab − closing − fee) computed from the SAME ARV/rehab this
   *  opener used. The opener NEVER exceeds it — the first offer can never sit
   *  above your maximum. Null only on a hold. */
  maoBound: number | null;
  /** True when the anchored opener exceeded maoBound and was clamped to it. */
  boundedToMao: boolean;
  /** BEST-CASE OPENER (feasibility, operator 2026-07-25): the opener this same
   *  math would produce at ZERO rehab — perfect condition, most generous case
   *  possible. Same anchor, same buy-box, same flip-MAO bound, and still
   *  bounded at 85% of list (numbers above the tripwire never send, so the
   *  best SENDABLE case stays below it). If even THIS number is hopelessly below the ask, no rehab estimate,
   *  photo, or walkthrough can ever close the gap — the deal is structurally
   *  infeasible and texting any number just burns the agent relationship
   *  (529 Bina "insane ask" / 2048 Joffre "is that what you mean?" class).
   *  Read by the corroboration gate's infeasible_ask signal. Null on a hold. */
  bestCaseOpener: number | null;
  detail: string;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** HOLD result — no trusted value basis (or a guard tripped), so NO autonomous
 *  opener. The opener is null and the record routes to operator review. This
 *  REPLACES the retired flat-65%-of-list fallback (operator 2026-06-28): we
 *  never text a number anchored to the seller's list price. */
// ── Placeholder-rehab TURNKEY TEST (2026-07-31, revised same day) ────────
//
// The first version of this guard HELD every opener built on a placeholder
// rehab. Measured against the live pool that was 1,266 of 1,555 never-texted
// records — 81% — against a vision drain that clears 12/day, i.e. 106 days to
// catch up. First-touch offers had ALREADY fallen 37/day (7/23) to 3/day
// (7/31); a blanket hold would have taken them to zero. A correct guard that
// stops the business is not a correct guard.
//
// The real defect at 256 Westchester was never "no vision ran" — it was a
// RENOVATED house. And there is a free, deterministic signal for that, which
// the pricer already holds both halves of at decision time.
//
// THE TEST, derived rather than guessed: the placeholder ASSUMES rehab =
// ROUGH_REHAB_PCT_OF_ARV × ARV. A house needing that much work cannot be
// worth more than the remainder, so a seller asking at or above
// (1 − ROUGH_REHAB_PCT_OF_ARV) × ARV is asking more than a house needing that
// rehab could possibly be worth. At that point the assumption contradicts the
// ask, and the number built on it is not defensible.
//
//   256 Westchester   $234,900 / $223,750 = 105% ≥ 70%  → HOLD  ✓
//   Detroit shell      $30,000 / $150,000 =  20% <  70% → SEND  ✓
//
// The threshold is not a knob — it is 1 − the placeholder itself, so the two
// can never drift apart.
export const PLACEHOLDER_TURNKEY_RATIO = 1 - ROUGH_REHAB_PCT_OF_ARV;

/** Absolute dollar ceiling for an opener whose rehab term is a PLACEHOLDER.
 *  The turnkey ratio above is scale-free, so a large ARV makes a guessed
 *  renovation look safer the bigger it gets — 1909 Flat Shoals passed the
 *  ratio at 55% of list and autonomously texted $266,250 carrying a ~$203,000
 *  invented rehab. This business wholesales $30-70k houses; an autonomous
 *  six-figure offer built on a guess is a different risk class than the one
 *  the operator signed up for. Above this, HOLD for a real vision read.
 *  Env-tunable (PLACEHOLDER_REHAB_MAX_OPENER_USD). */
export const PLACEHOLDER_REHAB_MAX_OPENER_USD = (() => {
  const raw = Number(process.env.PLACEHOLDER_REHAB_MAX_OPENER_USD);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 75_000;
})();

/** Pure: is a placeholder-rehab opener unsafe for THIS listing?
 *  Unknown list price fails CLOSED — without the ask we cannot rule out a
 *  turnkey house, and that is the exact case this exists to catch. */
export function placeholderRehabIsUnsafe(
  listPrice: number | null | undefined,
  arvUsed: number | null | undefined,
): boolean {
  const list = typeof listPrice === "number" && Number.isFinite(listPrice) && listPrice > 0 ? listPrice : null;
  const arv = typeof arvUsed === "number" && Number.isFinite(arvUsed) && arvUsed > 0 ? arvUsed : null;
  if (arv == null) return true;   // no value basis → cannot judge → hold
  if (list == null) return true;  // no ask → cannot judge → hold
  return list >= arv * PLACEHOLDER_TURNKEY_RATIO;
}

function holdResult(
  ceilingSource: RoughCeilingResult["source"],
  detail: string,
  extra?: Partial<
    Pick<PricerResult, "arvDistrusted" | "flagReseed" | "flooredToFallback" | "assumedScope">
  >,
): PricerResult {
  return {
    opener: null,
    // A HOLD still has to say WHY the rehab was what it was. When rehab came
    // from a scope tier (nobody has been inside), the hold is a "we guessed the
    // interior" hold — the vision queue can clear it. Dropping the scope here
    // sent those records to operator review instead, where they sat.
    assumedScope: extra?.assumedScope ?? null,
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
    overListTripwire: false,
    maoBound: null,
    boundedToMao: false,
    bestCaseOpener: null,
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
    sqft: input.sqft ?? null,
  });

  // ── PLACEHOLDER-REHAB HOLD (256 Westchester, operator 2026-07-31) ──────
  // A rough ceiling built on ROUGH_REHAB_PCT_OF_ARV is a GUESSED rehab, and
  // rehab is the largest term in the opener after ARV itself — so guessing it
  // is guessing the offer. 256 Westchester: ARV ≈ $223,750 (right — the agent
  // said $230k), placeholder rehab 0.30×ARV = $67,125 (the house needed $0),
  // opener $74,500 on a $234,900 renovated listing. The ARV was never the
  // problem; the invented renovation was.
  //
  // This branch used to accept `..._placeholder_rehab` as a SEND basis
  // alongside the vision-backed one. It no longer does. The record HOLDs and
  // is routed to the VISION QUEUE (lib/pricing/vision-queue) — machine work
  // that a drain cron clears autonomously, deliberately NOT an
  // h2_opener_hold operator proposal.
  // ── BUY-BOX ARV PATH ── the ONLY path that produces a sent opener. Ceiling
  // from a trusted ARV + sourced buy-box.
  if (rough.source === "rough_buybox_arv" || rough.source === PLACEHOLDER_REHAB_SOURCE) {
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
    const fee = effectiveWholesaleFee(input.wholesaleFee);
    const flip = computeFlipOffer({ arv: trustedArv, rehab: rough.rehabUsed, assignmentFee: fee });
    if (flip.status === "no_deal" || flip.offer == null || flip.offer <= 0) {
      return holdResult(
        rough.source,
        `does not pencil as a flip — MAO bound ≤ $0 (0.70×ARV $${(trustedArv ?? 0).toLocaleString()} − rehab $${(rough.rehabUsed ?? 0).toLocaleString()} − closing − fee $${fee.toLocaleString()}). ` +
          `HELD for operator review (rental/creative lane candidate; never list-anchored)`,
        { assumedScope: rough.assumedScope ?? null },
      );
    }
    const maoBound = flip.offer;

    if (gate.ok && gate.opener != null) {
      const boundedToMao = gate.opener > maoBound;
      const opener = boundedToMao ? maoBound : gate.opener;

      // ── BEST-CASE OPENER (feasibility test, operator 2026-07-25) ─────────
      // The zero-rehab twin of the sent number: same ARV, same buy-box, same
      // anchor, same flip-MAO bound, same never-over-list cap — rehab = $0
      // (perfect condition, the most generous case the formula allows). This
      // number is NEVER texted; the corroboration gate reads it to answer one
      // question: could ANY offer we're able to make plausibly reach this ask?
      // If even the perfect-condition figure is hopelessly under list, no
      // rehab estimate can bridge the gap — the ask is structurally
      // unreachable, and texting the (lower, pessimistic) real opener only
      // reads as an insult on a non-distressed house (529 Bina / 2048 Joffre).
      const bestFlip = computeFlipOffer({ arv: trustedArv, rehab: 0, assignmentFee: fee });
      let bestCase = Math.round((trustedArv! * input.arvPctMax! - fee) * (gate.anchorPct ?? 1));
      if (bestFlip.offer != null && bestFlip.offer > 0 && bestFlip.offer < bestCase) bestCase = bestFlip.offer;
      if (list != null) bestCase = Math.min(bestCase, Math.floor(list * NEVER_OVER_LIST_PCT));
      const bestCaseOpener = bestCase > 0 ? bestCase : null;
      // ── GUARD: LOW-OPENER FLOOR (Hole B) ── a tiny-but-positive ceiling
      // yields a broken-looking micro-opener. Below max(PCT×list, USD) → HOLD
      // for operator review instead of sending it (and instead of the retired
      // list-fraction rail).
      if (list != null) {
        const floor = minOfferFloor(list, rough.arvUsed);
        if (opener < floor) {
          const basis =
            `max ${Math.round(LOW_OPENER_FLOOR_PCT_OF_ARV * 100)}%×ARV` +
            (pos(rough.arvUsed) ? ` $${Math.round(rough.arvUsed).toLocaleString()}` : " (none)") +
            `, ${Math.round(LOW_OPENER_FLOOR_PCT_OF_LIST * 100)}%×list`;
          return holdResult(
            rough.source,
            `buy-box opener $${opener.toLocaleString()} below floor $${Math.round(floor).toLocaleString()} ` +
              `(${basis}, $${LOW_OPENER_FLOOR_USD.toLocaleString()}) — ` +
              `micro-opener suppressed, HELD for operator review`,
            { flooredToFallback: true, assumedScope: rough.assumedScope ?? null },
          );
        }
      }
      // ── PLACEHOLDER-REHAB HOLD (256 Westchester, operator 2026-07-31) ──
      // LAST guard in this branch, deliberately: every more-specific
      // diagnostic above (size-band extrapolation, over-list tripwire, MAO
      // bound, sub-floor) must keep its own hold reason. Those are ARV
      // problems, and vision will not fix an ARV problem — mislabelling them
      // "needs vision" would route them to a drain cron that can never clear
      // them. Only a number that is otherwise SENDABLE, and fails solely
      // because its rehab was invented, belongs in the vision queue.
      //
      // The defect: ARV ≈ $223,750 (correct — the agent said $230k), but
      // rehab = 0.30×ARV = $67,125 on a house needing $0, giving a $74,500
      // opener against a $234,900 turnkey listing. Rehab is the largest term
      // after ARV; guessing it is guessing the offer.
      const guarded: PricerResult = overListTripwireGuard(
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
          overListTripwire: false,
          maoBound,
          boundedToMao,
          bestCaseOpener,
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
      // PLACEHOLDER-REHAB MARK (256 Westchester, operator 2026-07-31).
      // A FLAG, deliberately — not an early return. Every downstream
      // diagnostic (the over-list tripwire here, the corroboration gate in
      // priceOpenerWithSeed) must still run and keep its own hold reason:
      // those are ARV problems, and vision cannot fix an ARV problem, so
      // labelling them "needs vision" would route them to a drain cron that
      // can never clear them. The send paths convert this flag to a HOLD
      // only once a number has survived everything else.
      // TWO independent ways a placeholder-rehab opener is unsafe:
      //  (a) TURNKEY RATIO — the ask contradicts the assumed rehab (256
      //      Westchester). Catches renovated houses at any price.
      //  (b) ABSOLUTE EXPOSURE (1909 Flat Shoals, 2026-08-04) — the ratio test
      //      PASSED (list $375,000 vs a seed ARV ≈ $678,000 = 55%) and the
      //      system autonomously texted $266,250 on a house nobody had
      //      assessed, with a GUESSED $203,000 renovation inside it. A ratio
      //      cannot catch this: the bigger the ARV, the safer it looks, while
      //      the invented rehab term — and the dollars we commit — grow with
      //      it. Above this ceiling a placeholder rehab must be replaced by a
      //      real vision read before any number reaches a seller.
      const withScope = rough.assumedScope ? { ...guarded, assumedScope: rough.assumedScope } : guarded;
      // NOBODY HAS BEEN INSIDE — the exposure cap applies to a SCOPE-derived
      // rehab exactly as it does to a %-of-ARV placeholder (2026-08-07). A
      // scope tier is a better guess, not a vision read, so the $75k
      // autonomous-exposure ceiling from #188 must still bite. Without this,
      // wiring scope tiers would have silently un-capped the largest
      // autonomous offers the system can make.
      const rehabUnseen = rough.source === PLACEHOLDER_REHAB_SOURCE || rough.assumedScope != null;
      return rehabUnseen &&
        (placeholderRehabIsUnsafe(list, rough.arvUsed) ||
          (pos(guarded.opener) && guarded.opener > PLACEHOLDER_REHAB_MAX_OPENER_USD))
        ? { ...withScope, placeholderRehab: true }
        : withScope;
    }
    // Buy-box ceiling did not pencil (≤0 — rehab ate the value) → HOLD. A non-
    // deal correctly holds; we never paper over it with a list fraction.
    return holdResult(
      rough.source,
      `buy-box ceiling did not pencil (${gate.reason}) — HELD for operator review (rehab eats the buy-box; never list-anchored)`,
      { assumedScope: rough.assumedScope ?? null },
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

/** GUARD: OVER-LIST TRIPWIRE (Hole A — Option B, operator ruling
 *  recmy2Vwp1wMA1Vs8 2026-07-06; the producer path was killed 2026-07-27).
 *  A value-anchored opener above NEVER_OVER_LIST_PCT × list means one of two
 *  things: a genuine deep-discount listing (ARV ≫ list) or broken inputs (an
 *  inflated ARV — the Avon size extrapolation, hot-pocket seed, and Robison
 *  portfolio-deed classes). Both belong to the operator, so the record HOLDS
 *  and surfaces (Type 2C) with the computed number preserved in the receipt.
 *  The RETIRED behavior — substituting floor(0.85 × list) and sending — was a
 *  laundering step: it converted every upstream ARV corruption into a
 *  confident, list-anchored text (the 43-record capped_to_list cohort,
 *  533 Robison $29,750, 1122 West Ave $110,499). A list fraction is not a
 *  price; nothing sends from this branch. The threshold stays FLOORED so an
 *  opener exactly at 85% of list still sends (≤ compares against the same
 *  figure the >85% send rail uses). */
function overListTripwireGuard(r: PricerResult, list: number | null): PricerResult {
  if (list == null || r.opener == null) return r;
  const threshold = Math.floor(list * NEVER_OVER_LIST_PCT);
  if (r.opener <= threshold) return r;
  const reseedWorthy = r.confidence !== "STRONG";
  return {
    ...r,
    opener: null,
    basis: "hold_no_value_basis",
    cappedToList: false,
    overListTripwire: true,
    flagReseed: reseedWorthy,
    detail:
      `${r.detail} | OVER-LIST TRIPWIRE: computed opener $${r.opener.toLocaleString()} exceeds ` +
      `${Math.round(NEVER_OVER_LIST_PCT * 100)}% of list ($${threshold.toLocaleString()}) — ` +
      (reseedWorthy
        ? `ARV implausibly high on a ${r.confidence} basis, flagged for re-seed; `
        : `STRONG seed reads as a deep-discount listing; `) +
      `HELD for operator review (Type 2C) — the 0.85×list clamp is retired and never produces a number (ruling recmy2Vwp1wMA1Vs8)`,
  };
}
