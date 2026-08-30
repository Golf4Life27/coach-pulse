// LIST-ANCHOR SOFT OPENER — the two-stage doctrine's first-contact number.
// @agent: crier
//
// Operator ruling 2026-08-30 (Spine rec8eZG5hH16FFyF2, after the Roselawn
// post-mortem): first-contact cash openers are 62% × list price, phrased SOFT
// ("depending on condition, somewhere around $X"), at volume. The hard
// value-anchored math (per-market-pricer, standard-5 comp verification, the
// two-lane MAO ceiling) moves to the NEGOTIATION stage — it fires on the first
// reply, before any number is firmed, revised, or reaffirmed. This deliberately
// reverses the "no constant ratio" rule at the opener stage ONLY: the opener's
// job is volume and response rate, and the soft phrasing is what keeps the
// sticky-offer rule survivable (the anchor that sticks is a conditional
// ballpark, not a commitment).
//
// Blackmoor-class protection ($84.5k texted at a ~$40k house, 2026-06-28) does
// NOT live here anymore — it lives in (a) the soft template, which commits to
// nothing, and (b) the negotiation stage, which must verify before firming.
// The min-offer floor on the send path still guards the bottom end.
//
// Pure. No I/O. Produced result is shaped exactly like priceOpenerWithSeed's
// so the send path treats both modes identically downstream.

import type { OpenerWithSeedResult } from "@/lib/opener-pricing";
import { buildDerivation } from "@/lib/pricing/opener-derivation";
import { OFFER_ROUND_STEP_USD } from "@/lib/pricing/offer-rounding";

/** Opener_Basis receipt label for a sent list-anchor opener. */
export const LIST_ANCHOR_BASIS = "list_anchor_soft_v1";

/** Default anchor: 62% of list (operator: "60-65%", chose 62). */
export const DEFAULT_LIST_ANCHOR_PCT = 0.62;

/** The operator's approved band — env values outside it are ignored. */
const LIST_ANCHOR_PCT_MIN = 0.6;
const LIST_ANCHOR_PCT_MAX = 0.65;

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Effective anchor pct: H2_LIST_ANCHOR_PCT clamped to the ruling's 60-65%
 *  band; anything unparseable or outside the band falls back to 0.62. */
export function listAnchorPct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.H2_LIST_ANCHOR_PCT);
  return Number.isFinite(raw) && raw >= LIST_ANCHOR_PCT_MIN && raw <= LIST_ANCHOR_PCT_MAX
    ? raw
    : DEFAULT_LIST_ANCHOR_PCT;
}

/** Mode switch for the H2 send path. Explicit opt-in only (the
 *  CREATIVE_OUTREACH_LIVE lesson): exactly "list_anchor_soft_v1" activates the
 *  two-stage opener; anything else keeps the value-anchored pricer. */
export function isListAnchorMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.H2_OPENER_MODE ?? "").trim() === LIST_ANCHOR_BASIS;
}

/** Pure: price a first-contact opener at pct × list, rounded to the standard
 *  offer step. HOLDs (opener null) only when there is no usable list price —
 *  every value/ARV judgement is deferred to the negotiation stage by design. */
export function priceOpenerListAnchor(
  listPrice: number | null | undefined,
  pct: number = listAnchorPct(),
): OpenerWithSeedResult {
  const hold = !pos(listPrice);
  const opener = hold
    ? null
    : Math.max(
        OFFER_ROUND_STEP_USD,
        Math.round((pct * (listPrice as number)) / OFFER_ROUND_STEP_USD) * OFFER_ROUND_STEP_USD,
      );
  const basisLabel = hold ? "hold_no_list_price" : LIST_ANCHOR_BASIS;
  const detail = hold
    ? "list-anchor opener HOLD: no usable list price"
    : `list-anchor soft opener: ${(pct * 100).toFixed(0)}% × list $${(listPrice as number).toLocaleString()} = $${opener!.toLocaleString()} (two-stage doctrine, operator 2026-08-30)`;
  return {
    result: {
      opener,
      basis: hold ? "hold_no_value_basis" : "list_anchor_soft",
      confidence: "NONE",
      ceiling: null,
      ceilingSource: hold ? "hold_no_value_basis" : "list_anchor_soft",
      arvUsed: null,
      rehabUsed: null,
      placeholderRehab: false,
      assumedScope: null,
      anchorPct: hold ? null : pct,
      arvDistrusted: false,
      flagReseed: false,
      overArvList: false,
      flooredToFallback: false,
      cappedToList: false,
      overListTripwire: false,
      maoBound: null,
      boundedToMao: false,
      bestCaseOpener: null,
      detail,
    },
    arvSource: "none",
    arvUsed: null,
    basisLabel,
    corroborationFlags: [],
    assumedScope: null,
    derivation: buildDerivation({
      opener,
      basis: basisLabel,
      arvSource: "none",
      anchor: hold ? null : pct,
      roundTo: OFFER_ROUND_STEP_USD,
      flags: [],
    }),
  };
}
