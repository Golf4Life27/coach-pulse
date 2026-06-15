// Opener pricing with ARV source-swap (Maverick 2026-06-14, root-cause fix).
// @agent: appraiser/crier
//
// THE SOURCE-SWAP. The stored Real_ARV_Median field is contaminated — it
// largely holds AS-IS value (wrong basis), so the full-437 dry-run showed
// renovated-ARV < list on a fifth of the cohort. This helper prefers the
// renovated-comp $/sqft from ZIP_ARV_Seed (auto-seeded once per ZIP) over
// the contaminated field, then runs the guarded per-market pricer. Stored
// ARV is the fallback only when no seed exists yet; flat 65%-of-list is the
// final fallback.
//
// ONE code path for both the live intake loop (opener-writes) and the
// read-only dry-run eyeball — no parallel pricing.
//
// Pure. No I/O (the caller loads the seed + anchor).

import { priceOpener, type PricerResult } from "@/lib/per-market-pricer";
import { arvForSubjectFromSeed, type ZipArvSeed } from "@/lib/zip-arv-seed-store";

export type ArvSource = "seed_renovated" | "stored" | "none";

export interface OpenerWithSeedInput {
  listPrice?: number | null;
  /** Contaminated stored Real_ARV_Median — used ONLY when no seed exists. */
  storedArv?: number | null;
  /** Stored ARV confidence (HIGH/MED/LOW) → STRONG/THIN when used. */
  storedArvConfidence?: "HIGH" | "MED" | "LOW" | null;
  estRehabMid?: number | null;
  estRehab?: number | null;
  /** Subject square footage — needed to turn a seed $/sqft into a $ ARV. */
  sqft?: number | null;
  /** Sourced market buy-box (markets.json arv_pct_max). */
  arvPctMax?: number | null;
  wholesaleFee?: number | null;
  anchorPct?: number | null;
  /** The ZIP's renovated-comp seed, when one exists. */
  seed?: ZipArvSeed | null;
}

export interface OpenerWithSeedResult {
  result: PricerResult;
  /** Which ARV basis fed the pricer. */
  arvSource: ArvSource;
  arvUsed: number | null;
  /** Compact basis label for the Opener_Basis receipt field. */
  basisLabel: string;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function mapStoredConfidence(c: "HIGH" | "MED" | "LOW" | null | undefined): "STRONG" | "THIN" | null {
  if (c === "HIGH") return "STRONG";
  if (c === "MED" || c === "LOW") return "THIN";
  return null;
}

/** Pure: price an opener, preferring the renovated-comp seed ARV over the
 *  contaminated stored field. */
export function priceOpenerWithSeed(input: OpenerWithSeedInput): OpenerWithSeedResult {
  // Source-swap: seed renovated $/sqft × subject sqft wins when both exist.
  let arvForPricer: number | null = null;
  let arvSource: ArvSource = "none";
  let arvConfidence: "STRONG" | "THIN" | null = null;

  const seedArv = input.seed ? arvForSubjectFromSeed(input.seed, input.sqft ?? null) : null;
  const seedDontPrice = !!input.seed && (input.seed.dontPrice || input.seed.confidence === "DONT_PRICE");
  if (pos(seedArv)) {
    arvForPricer = seedArv;
    arvSource = "seed_renovated";
    arvConfidence = input.seed!.confidence === "STRONG" ? "STRONG" : "THIN";
  } else if (seedDontPrice) {
    // The ZIP was evaluated and explicitly marked do-not-price (comps too few
    // / too noisy). Do NOT fall back to the contaminated stored ARV — go
    // straight to the flat 65%-of-list rail (arvForPricer stays null).
    arvSource = "none";
  } else if (pos(input.storedArv)) {
    arvForPricer = input.storedArv;
    arvSource = "stored";
    arvConfidence = mapStoredConfidence(input.storedArvConfidence);
  }

  const result = priceOpener({
    listPrice: input.listPrice ?? null,
    realArvMedian: arvForPricer,
    estRehabMid: input.estRehabMid ?? null,
    estRehab: input.estRehab ?? null,
    arvPctMax: input.arvPctMax ?? null,
    wholesaleFee: input.wholesaleFee ?? null,
    anchorPct: input.anchorPct ?? null,
    arvConfidence,
  });

  // Compact label for the Opener_Basis receipt.
  const basisLabel =
    result.cappedToList ? "capped_to_list"
    : result.basis === "hold_no_inputs" ? "hold"
    : result.basis === "list_fraction_65" ? "list_fraction_65"
    : arvSource === "seed_renovated" ? "arv_buybox_seed"
    : "arv_buybox_stored";

  return { result, arvSource, arvUsed: arvForPricer, basisLabel };
}
