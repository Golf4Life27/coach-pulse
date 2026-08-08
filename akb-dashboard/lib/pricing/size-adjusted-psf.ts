// SIZE-ADJUSTED $/SQFT — stop pricing a 790 sqft house off 2,000 sqft comps.
// @agent: appraiser
//
// THE BUG (found on 2302 S Randolph, 2026-08-07). A ZIP seed stores ONE median
// renovated $/sqft and the pricer applies it to every house in that ZIP:
//     ARV = seed_psf × subject_sqft
// But $/sqft is not constant across house size — it falls as houses get
// bigger, because land, kitchens, baths and mechanicals are largely fixed
// costs spread over more feet.
//
// Measured in 46203 across its own 12 comps:
//     3 largest  (1,904-2,737 sqft) average $121/sqft
//     3 smallest (1,138-1,299 sqft) average $165/sqft
//     linear fit: psf = -0.0417 × sqft + 215   (-$42 per 1,000 sqft)
//
// 2302 S Randolph is 790 sqft — smaller than ALL 12 comps. The seed median of
// $149 gave ARV $117,710; the size fit gives $144,129. A ~$26,000 ARV error
// that CLEARED the existing 1.5x size-band guard by 31 square feet, then
// pushed the record into cash_no_pencil.
//
// BLAST RADIUS: cash_no_pencil (175) + failed_corroboration (42) = 217 of the
// 335 records currently held with no value basis. Not all are this bug, but
// this is the largest single correctable cause.
//
// THIS IS NOT A PER-ZIP RULE. Every seed already stores its own comps with
// sqft and price (verified on 48228, 48219, 48235, 46203, 30318). One
// algorithm reads whatever comps each ZIP happens to have. Zero new API calls.
// It generalises because the DATA is per-ZIP, not the RULE.
//
// SAFETY: the fit is CLAMPED to the observed comp psf range. A regression
// evaluated outside the data can produce anything; a renovated $/sqft outside
// what actually sold in that ZIP is not evidence, it is arithmetic. And when
// the comps do not actually support a size relationship — too few, or a flat
// or backwards slope — this returns the seed median unchanged. It refuses to
// invent a trend that is not there.

export interface SeedComp {
  sqft: number;
  psf: number;
}

/** Minimum comps before a slope is worth trusting at all. */
export const MIN_COMPS_FOR_FIT = 6;

/** The slope must be NEGATIVE and steeper than this to be acted on ($/sqft per
 *  sqft). -0.005 is $5 per 1,000 sqft — below that the correction is noise and
 *  the seed median is fine. */
export const MIN_SLOPE_MAGNITUDE = 0.005;

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export type PsfAdjustSource =
  | "size_fit"        // the comps supported a slope and it was applied
  | "seed_median"     // no usable slope — seed median returned unchanged
  | "no_subject_sqft" // cannot adjust without knowing the subject's size
  | "insufficient_comps";

export interface PsfAdjustment {
  psf: number | null;
  source: PsfAdjustSource;
  /** Slope in $/sqft per sqft, when a fit ran. */
  slope: number | null;
  /** Whether the fit was clamped to the observed comp range. */
  clamped: boolean;
  detail: string;
}

/** Pure: least-squares slope + intercept of psf against sqft. */
export function fitPsfBySize(comps: readonly SeedComp[]): { slope: number; intercept: number } | null {
  const usable = comps.filter((c) => pos(c.sqft) && pos(c.psf));
  if (usable.length < 2) return null;
  const n = usable.length;
  const mx = usable.reduce((s, c) => s + c.sqft, 0) / n;
  const my = usable.reduce((s, c) => s + c.psf, 0) / n;
  const denom = usable.reduce((s, c) => s + (c.sqft - mx) ** 2, 0);
  if (denom === 0) return null; // every comp the same size — no size signal
  const slope = usable.reduce((s, c) => s + (c.sqft - mx) * (c.psf - my), 0) / denom;
  return { slope, intercept: my - slope * mx };
}

/** Pure: the renovated $/sqft to use for THIS subject, given the ZIP's comps.
 *
 *  Returns the seed median untouched whenever the comps do not support a size
 *  relationship. The failure mode this replaces was silent and systematic; the
 *  replacement must not introduce a noisier one. */
export function sizeAdjustedPsf(input: {
  comps: readonly SeedComp[];
  subjectSqft: number | null | undefined;
  seedMedianPsf: number | null | undefined;
}): PsfAdjustment {
  const { comps, subjectSqft, seedMedianPsf } = input;
  const median = pos(seedMedianPsf) ? seedMedianPsf : null;

  if (!pos(subjectSqft)) {
    return { psf: median, source: "no_subject_sqft", slope: null, clamped: false,
      detail: "no subject sqft — cannot size-adjust; seed median returned" };
  }
  const usable = comps.filter((c) => pos(c.sqft) && pos(c.psf));
  if (usable.length < MIN_COMPS_FOR_FIT) {
    return { psf: median, source: "insufficient_comps", slope: null, clamped: false,
      detail: `only ${usable.length} usable comps (need ${MIN_COMPS_FOR_FIT}) — seed median returned` };
  }

  const fit = fitPsfBySize(usable);
  // Act ONLY on a negative slope of real magnitude. A positive slope (bigger
  // houses selling for MORE per foot) is not the known physical relationship
  // and is far more likely to be a thin-data artifact than a real market.
  if (!fit || fit.slope > -MIN_SLOPE_MAGNITUDE) {
    return { psf: median, source: "seed_median", slope: fit?.slope ?? null, clamped: false,
      detail: fit
        ? `slope ${fit.slope.toFixed(4)} is flat or positive — no size correction applied`
        : "no usable fit — seed median returned" };
  }

  const raw = fit.intercept + fit.slope * subjectSqft;
  const lo = Math.min(...usable.map((c) => c.psf));
  const hi = Math.max(...usable.map((c) => c.psf));
  const clamped = raw < lo || raw > hi;
  const psf = Math.min(hi, Math.max(lo, raw));

  return {
    psf: Math.round(psf * 100) / 100,
    source: "size_fit",
    slope: fit.slope,
    clamped,
    detail:
      `${Math.round(subjectSqft)} sqft → $${psf.toFixed(0)}/sqft ` +
      `(fit ${fit.slope.toFixed(4)}/sqft, ${(fit.slope * 1000).toFixed(0)} per 1,000 sqft; ` +
      `comps $${lo}-$${hi}/sqft${clamped ? ", CLAMPED to comp range" : ""})` +
      (median != null ? ` | seed median was $${median}` : ""),
  };
}

/** Pure: pull comps out of a seed's receipts JSON. Returns [] on anything
 *  unreadable — a bad receipt must not silently become a confident fit. */
export function compsFromReceipts(receiptsJson: string | null | undefined): SeedComp[] {
  if (!receiptsJson || typeof receiptsJson !== "string") return [];
  try {
    const parsed = JSON.parse(receiptsJson) as { comps?: Array<{ sqft?: unknown; psf?: unknown }> };
    if (!Array.isArray(parsed?.comps)) return [];
    return parsed.comps
      .filter((c) => pos(c.sqft) && pos(c.psf))
      .map((c) => ({ sqft: c.sqft as number, psf: c.psf as number }));
  } catch {
    return [];
  }
}
