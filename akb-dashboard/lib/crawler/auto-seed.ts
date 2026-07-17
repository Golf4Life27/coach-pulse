// Market auto-seed — the national crawler's frontier engine (Maverick
// 2026-06-14, HALF 2 step 3). @agent: scout/appraiser
//
// When the crawler hits a ZIP with no ARV seed yet, it seeds the ZIP itself
// from ONE representative comp pull: pull renovated sold comps for a
// representative listing → derive the ZIP's renovated $/sqft (lib/arv-
// intelligence) → cache it in ZIP_ARV_Seed. After that every listing in the
// ZIP prices for free. THIS is what makes the crawler national instead of
// Detroit-only: a market does NOT need full verification to send a
// conservative opener — it needs a rough, conservative, RECEIPTED number.
//
// COST: one paid comp pull per NEW ZIP seed (getSaleComparables audits its
// own paid_api_call), clamped by the daily budget governor (lib/spend/
// daily-budget) — the cap governs FRONTIER GROWTH, not steady-state pricing.
//
// SAFETY: restricted states (IL/MO/SC/NC/OK/ND) are never seeded (load-
// frozen in the market registry). A brand-new market's first seed is meant
// to be operator-eyeballed (seed + comp receipts) before its openers go
// live — that gate lives at the SEND layer (per-market auto-promote), not
// here; this module only produces the receipted seed.
//
// The gating decision is pure (decideAutoSeed) for tests; runAutoSeed
// composes the existing I/O (RentCast comps → ARV intel → seed store).

import { getSaleComparables, type CompPullWiden } from "@/lib/rentcast";
import { computeArvIntelligence, type ArvFilterOverride } from "@/lib/arv-intelligence";
import { getRestrictedStates } from "@/lib/markets/registry";
import {
  seedFromArvIntelligence,
  upsertZipArvSeed,
  type ZipArvSeed,
} from "@/lib/zip-arv-seed-store";

// ── WIDENED comp pull for ZIP seeds (Maverick 2026-06-15) ──────────────
// The default appraiser filters (0.5mi / 90d / beds-exact / sqft 0.8-1.2) are
// tuned for a SINGLE property's ARV and clip a thin-market ZIP seed down to
// 1-3 noisy comps. The seed needs a stable ZIP-level $/sqft, so it pulls WIDE
// and relaxes the engine's clip — all on the SAME single /avm/value call
// (RentCast bills per call, not per comp → cost-neutral, ~$0.20/seed). Every
// knob is env-tunable; the defaults are the launch values.
function num(env: string | undefined, dflt: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** RentCast request widening (more comps / wider radius / relaxed recency). */
export function seedPullWiden(): CompPullWiden {
  return {
    compCount: num(process.env.SEED_COMP_COUNT, 25),
    maxRadius: num(process.env.SEED_MAX_RADIUS_MI, 2),
    daysOld: num(process.env.SEED_MAX_AGE_DAYS, 365),
  };
}

/** ARV-engine filter relaxation for the seed path (mirrors the wider request
 *  so the engine doesn't re-clip what RentCast returned). Lowers the
 *  distressed-proxy activation floor so the outlier trim fires at the seed's
 *  comp counts — that is what cleans noise like $29 vs $171/sqft. */
export function seedFilterOverride(): ArvFilterOverride {
  return {
    comp_filters: {
      max_age_days: num(process.env.SEED_MAX_AGE_DAYS, 365),
      max_distance_miles: num(process.env.SEED_MAX_RADIUS_MI, 2),
      sqft_ratio_min: num(process.env.SEED_SQFT_RATIO_MIN, 0.6),
      sqft_ratio_max: num(process.env.SEED_SQFT_RATIO_MAX, 1.5),
      beds_exact_match_required: process.env.SEED_BEDS_EXACT === "true",
    },
    distressed_proxy: {
      apply_only_if_zip_has_at_least_comps: num(process.env.SEED_PROXY_MIN_COMPS, 3),
    },
  };
}

/** Seed-quality gate thresholds. */
export function seedQualityThresholds(): { minComps: number; maxCv: number } {
  return {
    minComps: num(process.env.SEED_MIN_COMPS, 4),
    maxCv: num(process.env.SEED_MAX_CV, 0.35),
  };
}

export interface SeedQualityInput {
  compCountUsed: number;
  /** $/sqft of the comps that fed the headline (positive values). */
  perSqftValues: number[];
}

export interface SeedQualityVerdict {
  pass: boolean;
  reason: string;
  compCount: number;
  meanPerSqft: number | null;
  /** Coefficient of variation (stddev / mean) of the comp $/sqft. */
  cv: number | null;
  minComps: number;
  maxCv: number;
}

/** Pure: is this comp set tight + deep enough to trust as a ZIP seed? Two
 *  gates: enough comps (count) AND low dispersion (coefficient of variation).
 *  A single $82k sale (CV undefined, count 1) or a $29/$72/$171 spread
 *  (CV ~0.65) fails; a $131/$135/$137 cluster (CV ~0.02) passes. */
export function evaluateSeedQuality(
  input: SeedQualityInput,
  opts?: { minComps?: number; maxCv?: number },
): SeedQualityVerdict {
  const t = seedQualityThresholds();
  const minComps = opts?.minComps ?? t.minComps;
  const maxCv = opts?.maxCv ?? t.maxCv;
  const vals = input.perSqftValues.filter((p) => Number.isFinite(p) && p > 0);
  const n = Math.min(input.compCountUsed, vals.length);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const cv =
    mean != null && mean > 0 && vals.length > 1
      ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) / mean
      : vals.length <= 1
      ? null
      : 0;

  const base = {
    compCount: input.compCountUsed,
    meanPerSqft: mean != null ? Math.round(mean) : null,
    cv: cv != null ? Math.round(cv * 1000) / 1000 : null,
    minComps,
    maxCv,
  };
  if (n < minComps) {
    return { pass: false, reason: `too_few_comps (${n} < ${minComps})`, ...base };
  }
  if (cv != null && cv > maxCv) {
    return { pass: false, reason: `dispersion_too_high (CV ${base.cv} > ${maxCv})`, ...base };
  }
  return { pass: true, reason: `ok (${n} comps, CV ${base.cv ?? "n/a"})`, ...base };
}

export type AutoSeedSkipReason =
  | "zip_invalid"
  | "restricted_state"
  | "already_seeded"
  | "budget_exhausted"
  | "no_representative_subject";

export interface AutoSeedDecision {
  seed: boolean;
  reason: AutoSeedSkipReason | "ok";
  detail: string;
}

export interface DecideAutoSeedInput {
  zip: string | null | undefined;
  state: string | null | undefined;
  /** ZIP already carries an ARV seed (listArvSeededZips). */
  alreadySeeded: boolean;
  /** Daily seed budget has headroom (lib/spend/daily-budget). */
  canSeed: boolean;
  /** A representative listing (address + ideally sqft) exists to pull comps
   *  against — RentCast comps are address-based. */
  hasRepresentativeSubject: boolean;
}

/** Pure: should the crawler spend a comp pull to seed this ZIP right now?
 *  Restricted-state skip first (never spend on a structurally-dead market),
 *  then already-seeded, then budget, then data availability. */
export function decideAutoSeed(input: DecideAutoSeedInput): AutoSeedDecision {
  const zip = String(input.zip ?? "").trim();
  if (!/^\d{5}$/.test(zip)) return { seed: false, reason: "zip_invalid", detail: `"${input.zip}" is not a 5-digit ZIP` };

  const state = (input.state ?? "").trim().toUpperCase();
  if (state && getRestrictedStates().has(state)) {
    return { seed: false, reason: "restricted_state", detail: `${state} is wholesale-restricted — never seeded` };
  }
  if (input.alreadySeeded) {
    return { seed: false, reason: "already_seeded", detail: `ZIP ${zip} already has an ARV seed — pricing is free, no pull` };
  }
  if (!input.canSeed) {
    return { seed: false, reason: "budget_exhausted", detail: "daily seed budget exhausted — frontier paused (seeded ZIPs keep pricing)" };
  }
  if (!input.hasRepresentativeSubject) {
    return { seed: false, reason: "no_representative_subject", detail: `ZIP ${zip} has no representative listing to pull comps against` };
  }
  return { seed: true, reason: "ok", detail: `ZIP ${zip} unseeded, budget OK, subject available — seed it` };
}

export interface RepresentativeSubject {
  address: string;
  city: string;
  state: string;
  zip: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFootage?: number | null;
}

export interface AutoSeedResult {
  ok: boolean;
  zip: string;
  seeded: boolean;
  /** A DONT_PRICE sentinel was written (gate failed) — the ZIP is "covered"
   *  (won't re-pull) but prices off the 65%-of-list rail, not the seed. */
  dontPrice?: boolean;
  confidence?: ZipArvSeed["confidence"];
  renovatedPerSqft?: number | null;
  compCount?: number;
  cv?: number | null;
  reason: string;
}

/** Write a DONT_PRICE sentinel for a ZIP whose comps were too thin/noisy to
 *  trust (or absent). Caches the verdict + receipts so the ZIP isn't re-pulled
 *  every run and so the pricer falls to the 65%-of-list rail. */
async function writeDontPriceSentinel(
  zip: string,
  state: string,
  compCount: number,
  reason: string,
  receipts: Record<string, unknown>,
  cv: number | null,
): Promise<AutoSeedResult> {
  try {
    await upsertZipArvSeed({
      zip,
      dontPrice: true,
      compCount,
      source: "rentcast_avm",
      state,
      fetchedAt: new Date().toISOString(),
      receiptsJson: JSON.stringify({ dont_price: true, reason, ...receipts }),
    });
  } catch (err) {
    return { ok: false, zip, seeded: false, reason: `dont_price_upsert_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    ok: true,
    zip,
    seeded: false,
    dontPrice: true,
    confidence: "DONT_PRICE",
    compCount,
    cv,
    reason: `dont_price ZIP ${zip}: ${reason} — pricing falls to 65%-of-list (sentinel cached, no re-pull)`,
  };
}

/** Async: seed one ZIP from a representative subject. Pulls RentCast comps
 *  (one paid call, self-audited), derives the renovated $/sqft via the
 *  Appraiser ARV engine, and upserts the seed. Targets the RENOVATED
 *  headline (condition_target=renovated) so the $/sqft is retail-ARV, not
 *  as-is. Zero comps → no seed (visible, not a fabricated number). */
export async function runAutoSeed(subject: RepresentativeSubject): Promise<AutoSeedResult> {
  const zip = subject.zip.trim();
  const state = subject.state ?? "";
  let comps;
  try {
    // WIDE pull: one /avm/value call with compCount/maxRadius/daysOld set so a
    // thin-market ZIP gathers enough sales for a stable cluster (cost-neutral).
    comps = await getSaleComparables(
      {
        address: subject.address,
        city: subject.city,
        state: subject.state,
        zip,
        bedrooms: subject.bedrooms ?? null,
        bathrooms: subject.bathrooms ?? null,
        squareFootage: subject.squareFootage ?? null,
      },
      undefined,
      seedPullWiden(),
    );
  } catch (err) {
    // Transient infra failure — NOT cached (no sentinel), so the ZIP stays
    // due and retries next run.
    return { ok: false, zip, seeded: false, reason: `comp_pull_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Zero comps is a real "RentCast has nothing here" signal → cache a
  // DONT_PRICE sentinel (prices off 65%-of-list, no re-pull churn).
  if (!comps || comps.length === 0) {
    return writeDontPriceSentinel(zip, state, 0, "zero_comps_returned", { comp_count_raw: 0 }, null);
  }

  const arv = computeArvIntelligence(
    comps,
    {
      zip,
      address: subject.address, // representative subject — never its own comp
      beds: subject.bedrooms ?? null,
      baths: subject.bathrooms ?? null,
      sqft: subject.squareFootage ?? null,
      condition_target: "renovated", // seed the RETAIL renovated $/sqft
    },
    { filterOverride: seedFilterOverride() }, // relax the engine clip to match the wide pull
  );

  // ── SEED-QUALITY GATE: enough comps + tight enough dispersion? ──
  const perSqftUsed = arv.comps_used.map((c) => c.per_sqft).filter((p) => p > 0);
  const quality = evaluateSeedQuality({ compCountUsed: arv.comp_count_used, perSqftValues: perSqftUsed });
  const receipts = {
    comp_count_raw: arv.comp_count_raw,
    comp_count_used: arv.comp_count_used,
    filter_quality: arv.filter_quality,
    cv: quality.cv,
    mean_per_sqft: quality.meanPerSqft,
    comps: arv.comps_used.slice(0, 12).map((c) => ({
      addr: c.formatted_address ?? null,
      price: c.price,
      sqft: c.sqft,
      psf: Math.round(c.per_sqft),
      sold: c.sale_date,
      dist: c.distance,
    })),
  };
  if (!quality.pass) {
    return writeDontPriceSentinel(zip, state, arv.comp_count_used, quality.reason, receipts, quality.cv);
  }

  const write = seedFromArvIntelligence(arv, "rentcast_avm", { state: subject.state });
  if (!write) {
    // Passed the count/dispersion gate but produced no usable $/sqft (e.g. no
    // sqft on the comps) → DONT_PRICE sentinel rather than a silent unseeded ZIP.
    return writeDontPriceSentinel(zip, state, arv.comp_count_used, "no_usable_per_sqft", receipts, quality.cv);
  }

  try {
    await upsertZipArvSeed(write);
  } catch (err) {
    return { ok: false, zip, seeded: false, reason: `seed_upsert_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const confidence: ZipArvSeed["confidence"] = arv.comp_count_used >= 5 ? "STRONG" : "THIN";
  return {
    ok: true,
    zip,
    seeded: true,
    confidence,
    renovatedPerSqft: write.renovatedPerSqft ?? null,
    compCount: write.compCount,
    cv: quality.cv,
    reason: `seeded ZIP ${zip}: $${write.renovatedPerSqft}/sqft from ${write.compCount} comps (${confidence}, CV ${quality.cv ?? "n/a"})`,
  };
}
