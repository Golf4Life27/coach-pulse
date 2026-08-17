// ZIP-level rent model — zero-marginal-cost rent estimates for the creative
// lane. @agent: appraiser
//
// THE PROBLEM (operator 2026-08-17): 2,812 of 3,137 creative-cohort records
// hold on no_rent_estimate, and a per-record RentCast rent call each would
// eat the remaining August budget. THE MOVE (operator-proposed, and it is
// the ZIP_ARV_Seed pattern applied to rent): the 325 records that ALREADY
// carry a paid RentCast rent estimate ARE the sample set. Fit a model on
// them — rent ≈ a_zip × sqft^β, the same sub-linear size scaling the ARV
// comp-adjuster uses (bigger homes rent for more in total, less per sqft) —
// and estimate the rest for free. A REAL rent call is bought only when a
// seller responds: precision is paid for on live deals, never on casts.
//
// CONSERVATISM (a modeled rent sets the PAYMENT we promise a seller, so an
// overestimate crushes the buyer's cashflow): modeled rents take a haircut —
// 10% when the record's own ZIP has enough sample points, 15% when we fall
// back to the metro pool — on top of the seller-finance pricer's own 0.9
// payment anchor and $150 cashflow floor. Errors push payments DOWN, the
// safe direction. Every estimate carries a basis label that survives into
// the offer derivation so modeled-rent offers are visible through dispo.
//
// HOLDS, never guesses: no sqft → no estimate (a size model cannot price an
// unsized house); ZIP + metro both under-sampled → no estimate; predictions
// outside sane rent bands → no estimate. The no_rent_estimate tail stays a
// tail until real data covers it.
//
// Pure. No I/O. Fit from the listings array the caller already holds.

export interface RentPoint {
  zip: string;
  /** Metro pool key — market id when known, else 3-digit ZIP prefix. */
  metro: string;
  sqft: number;
  rent: number;
}

export type RentBasis = "rentcast_avm" | "modeled_zip" | "modeled_metro";

export interface RentEstimate {
  rent: number;
  basis: RentBasis;
  /** Sample points behind the coefficient used. */
  samples: number;
  haircut: number;
}

export interface RentModelConfig {
  /** Sub-linear size exponent; fitted globally when enough points, else this. */
  betaDefault: number;
  minZipSamples: number;
  minMetroSamples: number;
  zipHaircut: number;
  metroHaircut: number;
  /** Sanity band on PREDICTED rents; outside → no estimate. */
  rentMinUsd: number;
  rentMaxUsd: number;
  roundUsd: number;
}

export const RENT_MODEL_DEFAULTS: RentModelConfig = {
  betaDefault: 0.6,
  minZipSamples: 3,
  minMetroSamples: 5,
  zipHaircut: 0.9,
  metroHaircut: 0.85,
  rentMinUsd: 400,
  rentMaxUsd: 3500,
  roundUsd: 5,
};

export interface RentModel {
  beta: number;
  totalPoints: number;
  zipCoef: Map<string, { a: number; n: number }>;
  metroCoef: Map<string, { a: number; n: number }>;
  cfg: RentModelConfig;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Fit β by log-log least squares on the pooled points; fall back to the
 *  default outside a sane sub-linear band (0.3–1.0) or on thin data. */
function fitBeta(points: RentPoint[], cfg: RentModelConfig): number {
  if (points.length < 20) return cfg.betaDefault;
  const xs = points.map((p) => Math.log(p.sqft));
  const ys = points.map((p) => Math.log(p.rent));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return cfg.betaDefault;
  const beta = num / den;
  return beta >= 0.3 && beta <= 1.0 ? beta : cfg.betaDefault;
}

/** Build the model from records that carry a REAL (paid) rent estimate. */
export function fitRentModel(
  points: RentPoint[],
  cfg: RentModelConfig = RENT_MODEL_DEFAULTS,
): RentModel {
  const clean = points.filter(
    (p) => pos(p.sqft) && pos(p.rent) && p.rent >= cfg.rentMinUsd / 2 && p.rent <= cfg.rentMaxUsd * 2 && /^\d{5}$/.test(p.zip),
  );
  const beta = fitBeta(clean, cfg);
  const byZip = new Map<string, number[]>();
  const byMetro = new Map<string, number[]>();
  for (const p of clean) {
    const coef = p.rent / Math.pow(p.sqft, beta);
    (byZip.get(p.zip) ?? byZip.set(p.zip, []).get(p.zip)!).push(coef);
    (byMetro.get(p.metro) ?? byMetro.set(p.metro, []).get(p.metro)!).push(coef);
  }
  const zipCoef = new Map<string, { a: number; n: number }>();
  for (const [zip, cs] of byZip) if (cs.length >= cfg.minZipSamples) zipCoef.set(zip, { a: median(cs), n: cs.length });
  const metroCoef = new Map<string, { a: number; n: number }>();
  for (const [m, cs] of byMetro) if (cs.length >= cfg.minMetroSamples) metroCoef.set(m, { a: median(cs), n: cs.length });
  return { beta, totalPoints: clean.length, zipCoef, metroCoef, cfg };
}

/** Estimate rent for a subject, or null when the model cannot say honestly. */
export function estimateRent(
  model: RentModel,
  subject: { zip: string | null | undefined; metro: string | null | undefined; sqft: number | null | undefined },
): RentEstimate | null {
  if (!pos(subject.sqft)) return null; // a size model cannot price an unsized house
  const zip = (subject.zip ?? "").trim();
  const size = Math.pow(subject.sqft, model.beta);
  const zipHit = zip ? model.zipCoef.get(zip) : undefined;
  const pick = zipHit
    ? { a: zipHit.a, n: zipHit.n, basis: "modeled_zip" as const, haircut: model.cfg.zipHaircut }
    : (() => {
        const m = (subject.metro ?? "").trim();
        const metroHit = m ? model.metroCoef.get(m) : undefined;
        return metroHit
          ? { a: metroHit.a, n: metroHit.n, basis: "modeled_metro" as const, haircut: model.cfg.metroHaircut }
          : null;
      })();
  if (!pick) return null;
  const raw = pick.a * size * pick.haircut;
  const rent = Math.round(raw / model.cfg.roundUsd) * model.cfg.roundUsd;
  if (rent < model.cfg.rentMinUsd || rent > model.cfg.rentMaxUsd) return null;
  return { rent, basis: pick.basis, samples: pick.n, haircut: pick.haircut };
}
