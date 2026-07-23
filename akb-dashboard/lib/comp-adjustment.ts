// SIZE-ADJUSTED, SIMILARITY-WEIGHTED SALES COMPARISON (reliability build #2,
// operator 2026-07-23). @agent: appraiser
//
// WHY. The seed carried ONE renovated $/sqft per ZIP and applied it linearly to
// every subject: ARV = psf × subjectSqft. That is the bug behind the 927 Avon
// over-offer — $/sqft compresses as houses get bigger, so a psf from ~1,000
// sqft comps massively overstates a 2,600 sqft subject. A pencil-and-paper
// wholesaler never does that: they pick the sales most COMPARABLE to the
// subject (closest in size, nearest, most recent) and ADJUST for the
// differences. This module does the same, in code.
//
// METHOD (sales comparison approach, appraiser-standard):
//   1. Scale each comp's PRICE to the subject's size with a SUB-LINEAR
//      elasticity β (price ∝ sqft^β, β<1): bigger houses cost more in total but
//      LESS per additional sqft. β=1 reproduces the old flat-$/sqft bug; β<1
//      damps size extrapolation the way the market actually behaves.
//   2. WEIGHT each comp by similarity to the subject — size proximity (a comp
//      the subject's size counts most) × distance proximity (nearer counts
//      more).
//   3. ARV = the similarity-weighted mean of the size-adjusted comp prices.
//
// This RAISES accuracy for subjects inside/near the comp size range (the deals
// that actually price) and stops averaging in dissimilar comps. It does NOT try
// to rescue a subject far outside the comp range (e.g. Avon) — that stays a
// HOLD via the corroboration gate. No method invents data that isn't there.
//
// Pure. No clock (recency is already applied when comps are pulled), no I/O.

/** Sub-linear size elasticity: price ∝ sqft^β. β<1 because $/sqft declines with
 *  size. 0.75 is a conservative middle (β=1 = old linear bug; lower = more
 *  damping). Env-tunable. */
export const COMP_SIZE_ELASTICITY = (() => {
  const raw = Number(process.env.COMP_SIZE_ELASTICITY);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
})();

/** Gaussian width (in log-sqft) for the size-similarity weight. ~0.35 means a
 *  comp 1.4× the subject's size keeps ~60% weight; 2× keeps ~30%. Env-tunable. */
export const COMP_SIZE_SIMILARITY_SIGMA = (() => {
  const raw = Number(process.env.COMP_SIZE_SIMILARITY_SIGMA);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.35;
})();

export interface AdjustComp {
  price: number;
  sqft: number;
  /** Distance to the subject in miles, when known (nearer weighted higher). */
  dist?: number | null;
}

export interface AdjustedArvResult {
  arv: number;
  /** Implied $/sqft at the subject's size (arv / subjectSqft) — telemetry. */
  perSqftEffective: number;
  /** Comps that carried usable price + sqft. */
  compCount: number;
  /** How the size-adjusted comps bracket the subject. */
  quality: "bracketed" | "edge" | "extrapolated";
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pos = (v: unknown): v is number => finite(v) && v > 0;

/** Pure: a size-adjusted, similarity-weighted ARV for the subject from its
 *  comps. Returns null when there is no usable comp (no positive price+sqft) or
 *  the subject sqft is invalid — the caller then falls back / HOLDS. */
export function adjustedArvFromComps(
  comps: readonly AdjustComp[],
  subjectSqft: number | null | undefined,
  opts?: { elasticity?: number; sigma?: number },
): AdjustedArvResult | null {
  if (!pos(subjectSqft)) return null;
  const beta = opts?.elasticity ?? COMP_SIZE_ELASTICITY;
  const sigma = opts?.sigma ?? COMP_SIZE_SIMILARITY_SIGMA;

  const usable = comps.filter((c) => pos(c.price) && pos(c.sqft));
  if (usable.length === 0) return null;

  let wSum = 0;
  let wPriceSum = 0;
  for (const c of usable) {
    // Size-adjust the comp's PRICE to the subject's size, sub-linearly.
    const adjPrice = c.price * Math.pow(subjectSqft / c.sqft, beta);
    // Similarity weight: size proximity (Gaussian in log-sqft) × distance.
    const logRatio = Math.log(c.sqft / subjectSqft);
    const sizeW = Math.exp(-(logRatio * logRatio) / (2 * sigma * sigma));
    // Nearer comps weigh more; unknown/invalid distance is neutral.
    const d = c.dist;
    const distW = finite(d) && d >= 0 ? 1 / (1 + d) : 0.5;
    const w = sizeW * distW;
    wSum += w;
    wPriceSum += w * adjPrice;
  }
  if (wSum <= 0) return null;

  const arv = Math.round(wPriceSum / wSum);

  // Quality: does the subject sit inside the comp size range, at its edge, or
  // beyond it? (The corroboration gate makes the HOLD call; this is telemetry.)
  const minSqft = Math.min(...usable.map((c) => c.sqft));
  const maxSqft = Math.max(...usable.map((c) => c.sqft));
  const quality: AdjustedArvResult["quality"] =
    subjectSqft >= minSqft && subjectSqft <= maxSqft ? "bracketed"
    : subjectSqft > maxSqft * 1.25 || subjectSqft < minSqft / 1.25 ? "extrapolated"
    : "edge";

  return { arv, perSqftEffective: Math.round(arv / subjectSqft), compCount: usable.length, quality };
}
