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

import { subjectOutsideCompSizeBand, seedFilterQuality, type ZipArvSeed } from "@/lib/zip-arv-seed-store";

/** arvUsed above this multiple of the seller's list price → the renovated ARV
 *  is implausibly high for an on-market listing (the ARV basis is inflated).
 *  Env-tunable. 2.5 is conservative: a genuine deep-discount distressed listing
 *  can run 1.3-1.8x; 2.5x+ is the Avon/inflated-seed regime. */
export const CORROB_ARV_LIST_MAX_RATIO = (() => {
  const raw = Number(process.env.CORROB_ARV_LIST_MAX_RATIO);
  return Number.isFinite(raw) && raw > 1 ? raw : 2.5;
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
}

export type CorroborationFlag =
  | "size_extrapolation"       // subject outside the comp size band
  | "arv_implausible_vs_list"  // renovated ARV ≫ list price
  | "psf_out_of_range"         // renovated $/sqft outside sane absolute bounds
  | "capped_untrusted_arv";    // opener only survived by clamping to list, on a non-STRONG ARV

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

  // 1. SIZE EXTRAPOLATION — subject far outside the seed's comp size band, so a
  //    psf-derived ARV is a size guess, not a comp. (927 Avon: 2,605 sqft priced
  //    off ~1,000 sqft comps.)
  if (input.seed) {
    const band = subjectOutsideCompSizeBand(input.seed, input.sqft ?? null);
    if (band.outside && band.reason) {
      flags.push("size_extrapolation");
      reasons.push(band.reason);
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

  // 4. CAPPED TO LIST ON AN UNTRUSTED ARV — the opener only fit under the
  //    never-over-list cap because it was clamped there; the underlying value
  //    exceeded list. Fine when the ARV is STRONG-corroborated (a real deep
  //    discount); a HOLD when it is not (THIN/STORED — likely inflated).
  //    (110 Leathers, 868 N Main both capped on extrapolated ARVs.)
  if (input.cappedToList && input.arvConfidence !== "STRONG") {
    flags.push("capped_untrusted_arv");
    reasons.push(
      `opener clamped to a fraction of list (value basis exceeded list) on a ${input.arvConfidence ?? "unlabeled"} ARV — not a trusted deep discount`,
    );
  }

  return { corroborated: flags.length === 0, flags, reasons };
}
