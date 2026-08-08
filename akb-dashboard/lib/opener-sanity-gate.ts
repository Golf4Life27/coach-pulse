// PRE-SEND CORROBORATION GATE (operator 2026-07-23, reliability build).
// @agent: appraiser/crier
//
// WHY THIS EXISTS. The pricing path grew by accretion: every catastrophe
// (Blackmoor 65%-of-list, Forest Manor opener-above-MAO, Avon size
// extrapolation) got its own bolted-on guard. That is a BLOCKLIST — a number
// sends UNLESS some specific guard happens to catch it, so the bugs live in the
// gaps between guards. This gate inverts the model to an ALLOWLIST: a computed
// opener must be CORROBORATED by independent, cheap signals to reach a seller.
// ANY red flag → the record HOLDS for operator review instead of sending.
//
// The default becomes "hold and ask" when the number is not corroborated,
// rather than "send and hope." That changes the FAILURE MODE: an un-anticipated
// pricing bug now stops and surfaces instead of texting a seller a wrong number.
//
// The signals are deliberately independent of the pricer's own math, so a bug
// IN the pricer cannot also disable its check. Each is napkin-cheap (no I/O).
// Pure.
//
// Test suite = the real failures this is built to catch: Avon St (size
// extrapolation), 110 Leathers / 868 N Main (ARV implausibly high vs list,
// opener only survived by clamping to list), plus a clean deal that must PASS.

import { subjectOutsideCompSizeBand, seedFilterQuality, seedComps, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import { sizeAdjustedPsf } from "@/lib/pricing/size-adjusted-psf";

/** arvUsed above this multiple of the seller's list price → the renovated ARV
 *  is implausibly high for an on-market listing (the ARV basis is inflated).
 *  Env-tunable. 2.5 is conservative: a genuine deep-discount distressed listing
 *  can run 1.3-1.8x; 2.5x+ is the Avon/inflated-seed regime. */
export const CORROB_ARV_LIST_MAX_RATIO = (() => {
  const raw = Number(process.env.CORROB_ARV_LIST_MAX_RATIO);
  return Number.isFinite(raw) && raw > 1 ? raw : 2.5;
})();

/** FEASIBILITY floor (operator 2026-07-25, 529 Bina "insane ask" / 2048 Joffre
 *  "is that what you mean?"): if even the BEST-CASE opener — the same formula at
 *  ZERO rehab, perfect condition — lands below this fraction of the seller's
 *  ask, no offer we are structurally able to make can ever reach them. Texting
 *  the (lower, pessimistic) real opener at that point is distress pricing
 *  aimed at a non-distressed ask — it can't convert, it can only burn the
 *  agent relationship. HOLD instead. Observed insult class: Joffre best-case
 *  48% of list, 1930 Cummings 39%, 2654 Elsinore 36% — all under 0.55, while
 *  genuine discounts clear it comfortably. NOTE the best-case number is a
 *  TEST, never a text: distressed deals keep the pessimistic opener untouched.
 *  Env-tunable. */
export const CORROB_MIN_BEST_CASE_PCT_OF_LIST = (() => {
  const raw = Number(process.env.CORROB_MIN_BEST_CASE_PCT_OF_LIST);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.55;
})();

/** Sane absolute bounds for a renovated $/sqft. Outside this the seed is junk
 *  (bad sqft, decimal error, luxury outlier). Env-tunable. */
export const CORROB_PSF_MIN = (() => {
  const raw = Number(process.env.CORROB_PSF_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 15;
})();
export const CORROB_PSF_MAX = (() => {
  const raw = Number(process.env.CORROB_PSF_MAX);
  return Number.isFinite(raw) && raw > 0 ? raw : 600;
})();

export interface CorroborationInput {
  /** The candidate opener the pricer produced (null ⇒ already a HOLD, nothing
   *  to corroborate). */
  opener: number | null;
  listPrice: number | null;
  /** The ARV that fed the pricer (seed $/sqft × sqft, or stored). */
  arvUsed: number | null;
  /** Subject square footage. */
  sqft: number | null;
  /** True when the opener only survived by being clamped to a fraction of list
   *  (the never-over-list cap bit — a signal the value basis exceeded list). */
  cappedToList: boolean;
  /** ARV trust label from the pricer. */
  arvConfidence: "STRONG" | "THIN" | "STORED" | null;
  /** The renovated-comp seed, when the ARV came from one (enables the size-band
   *  and comp-noise checks). */
  seed?: Pick<ZipArvSeed, "receiptsJson"> | null;
  /** Seed renovated $/sqft, for the absolute-$/sqft sanity bound. */
  renovatedPerSqft?: number | null;
  /** The ZERO-REHAB twin of the opener (per-market-pricer bestCaseOpener) —
   *  the most generous number the formula can ever produce for this deal.
   *  Used only by the infeasible_ask signal; never sent. */
  bestCaseOpener?: number | null;
}

export type CorroborationFlag =
  | "size_extrapolation"       // subject outside the comp size band
  | "arv_implausible_vs_list"  // renovated ARV ≫ list price
  | "psf_out_of_range"         // renovated $/sqft outside sane absolute bounds
  | "capped_untrusted_arv"     // opener only survived by clamping to list, on a non-STRONG ARV
  | "infeasible_ask";          // even the ZERO-rehab best case is hopelessly under the ask

export interface CorroborationResult {
  /** True ⇒ every signal corroborates the opener; safe to send. False ⇒ HOLD. */
  corroborated: boolean;
  flags: CorroborationFlag[];
  /** Human-readable reasons, aligned to `flags`. */
  reasons: string[];
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Pure: does this candidate opener clear every independent sanity signal?
 *  A null opener (already a HOLD) is trivially corroborated — there is nothing
 *  to send. Any red flag ⇒ corroborated=false ⇒ the caller HOLDS. */
export function corroborateOpener(input: CorroborationInput): CorroborationResult {
  const flags: CorroborationFlag[] = [];
  const reasons: string[] = [];

  // Nothing to send → nothing to corroborate.
  if (!pos(input.opener)) return { corroborated: true, flags, reasons };

  // 1. SIZE EXTRAPOLATION — the subject sits outside the sizes the seed's
  //    comps actually cover AND the seed cannot size-price it.
  //
  //    TIGHTENED 2026-08-08. The old test was a single 1.5× envelope, and both
  //    real mispricings sailed through it: 2302 S Randolph (790 sqft, smallest
  //    comp 1,138) cleared the floor by 31 sqft; 2175 W 106th (1,258 sqft,
  //    smallest comp 1,658) cleared it by 153. A subject smaller than EVERY
  //    comp passed a guard named "size extrapolation".
  //
  //    Since #194 the ARV ladder handles out-of-band subjects PROPERLY when
  //    the comps support a measured slope — that is what the fit is FOR, so
  //    holding those would undo the fix. The residual danger is precisely the
  //    subject outside the RAW comp range whose seed CANNOT support a slope
  //    fit (<6 usable comps, or a flat/positive slope): its ARV came from the
  //    assumed β-curve or flat psf extrapolating past the data.
  //      - outside 1.5× the band → flag, always (the Avon rail, unchanged)
  //      - outside the RAW band + no measured fit → flag (the new rail)
  //      - outside the RAW band + measured fit ran → PASS (clamped, sized)
  if (input.seed) {
    const band = subjectOutsideCompSizeBand(input.seed, input.sqft ?? null);
    if (band.outside && band.reason) {
      flags.push("size_extrapolation");
      reasons.push(band.reason);
    } else {
      const raw = subjectOutsideCompSizeBand(input.seed, input.sqft ?? null, 1.0);
      if (raw.outside && raw.reason) {
        const comps = seedComps(input.seed as Parameters<typeof seedComps>[0])
          .filter((c) => c.sqft > 0 && c.price > 0)
          .map((c) => ({ sqft: c.sqft, psf: c.price / c.sqft }));
        const fit = sizeAdjustedPsf({ comps, subjectSqft: input.sqft ?? null, seedMedianPsf: null });
        if (fit.source !== "size_fit") {
          flags.push("size_extrapolation");
          reasons.push(
            `${raw.reason}; and the seed's comps cannot support a measured size fit (${fit.source}) — ` +
              `the ARV extrapolates past the data with no size correction`,
          );
        }
      }
    }
  }

  // 2. ARV IMPLAUSIBLE VS LIST — an independent read on the ARV basis that does
  //    not touch the pricer's arithmetic: a renovated ARV several times the
  //    seller's own asking price is almost always an inflated basis.
  if (pos(input.arvUsed) && pos(input.listPrice)) {
    const ratio = input.arvUsed / input.listPrice;
    if (ratio > CORROB_ARV_LIST_MAX_RATIO) {
      flags.push("arv_implausible_vs_list");
      reasons.push(
        `renovated ARV $${input.arvUsed.toLocaleString()} is ${ratio.toFixed(1)}× the list $${input.listPrice.toLocaleString()} ` +
          `(> ${CORROB_ARV_LIST_MAX_RATIO}× ceiling) — ARV basis implausibly high`,
      );
    }
  }

  // 3. $/SQFT OUT OF RANGE — a junk seed $/sqft (bad sqft, unit/decimal error).
  if (pos(input.renovatedPerSqft) && (input.renovatedPerSqft < CORROB_PSF_MIN || input.renovatedPerSqft > CORROB_PSF_MAX)) {
    flags.push("psf_out_of_range");
    reasons.push(
      `renovated $/sqft $${input.renovatedPerSqft} outside sane bounds ($${CORROB_PSF_MIN}–$${CORROB_PSF_MAX})`,
    );
  }

  // 4. INFEASIBLE ASK — even the zero-rehab, perfect-condition best case can't
  //    plausibly reach the seller's ask. No rehab estimate, photo, or
  //    walkthrough changes the answer, so texting the pessimistic real opener
  //    is pure relationship burn (distress pricing on a non-distressed ask).
  //    Distressed stock is untouched: a real discount clears this easily.
  if (pos(input.bestCaseOpener) && pos(input.listPrice)) {
    const bestPct = input.bestCaseOpener / input.listPrice;
    if (bestPct < CORROB_MIN_BEST_CASE_PCT_OF_LIST) {
      flags.push("infeasible_ask");
      reasons.push(
        `even at ZERO rehab the best-case opener $${input.bestCaseOpener.toLocaleString()} is only ` +
          `${Math.round(bestPct * 100)}% of the $${input.listPrice.toLocaleString()} ask ` +
          `(< ${Math.round(CORROB_MIN_BEST_CASE_PCT_OF_LIST * 100)}% floor) — ask structurally unreachable; ` +
          `no sendable number exists, HOLD instead of insulting the agent`,
      );
    }
  }

  // 5. CAPPED TO LIST ON AN UNTRUSTED ARV — the opener only fit under the
  //    never-over-list cap because it was clamped there; the underlying value
  //    exceeded list. Fine when the ARV is STRONG-corroborated (a real deep
  //    discount); a HOLD when it is not (THIN/STORED — likely inflated).
  //    (110 Leathers, 868 N Main both capped on extrapolated ARVs.)
  //    NOTE (2026-07-27): the pricer's clamp producer is RETIRED — an over-
  //    threshold opener now HOLDS upstream (overListTripwire), so cappedToList
  //    never arrives true from the live path. This signal stays as belt-and-
  //    suspenders in case a capped number ever reappears from any caller.
  if (input.cappedToList && input.arvConfidence !== "STRONG") {
    flags.push("capped_untrusted_arv");
    reasons.push(
      `opener clamped to a fraction of list (value basis exceeded list) on a ${input.arvConfidence ?? "unlabeled"} ARV — not a trusted deep discount`,
    );
  }

  return { corroborated: flags.length === 0, flags, reasons };
}
