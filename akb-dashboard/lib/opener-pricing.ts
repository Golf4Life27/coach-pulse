// Opener pricing with ARV source-swap (Maverick 2026-06-14, root-cause fix).
// @agent: appraiser/crier
//
// THE SOURCE-SWAP. The stored Real_ARV_Median field is contaminated — it
// largely holds AS-IS value (wrong basis), so the full-437 dry-run showed
// renovated-ARV < list on a fifth of the cohort. This helper prefers the
// renovated-comp $/sqft from ZIP_ARV_Seed (auto-seeded once per ZIP) over
// the contaminated field, then runs the guarded per-market pricer. Stored
// ARV is the fallback only when no seed exists yet; with NO trusted ARV the
// pricer HOLDS for operator review (the flat 65%-of-list fallback was retired
// 2026-06-28 — see per-market-pricer header for the Blackmoor catastrophe).
//
// ONE code path for both the live intake loop (opener-writes) and the
// read-only dry-run eyeball — no parallel pricing.
//
// Pure. No I/O (the caller loads the seed + anchor).

import { priceOpener, type PricerResult } from "@/lib/per-market-pricer";
import { arvForSubjectFromSeed, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import { corroborateOpener, type CorroborationFlag } from "@/lib/opener-sanity-gate";

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
  /** Corroboration flags that turned a computed opener into a HOLD (empty when
   *  the opener sent or the record was already a HOLD for another reason). */
  corroborationFlags: CorroborationFlag[];
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
  let psfUsed: number | null = null;

  const seedArv = input.seed ? arvForSubjectFromSeed(input.seed, input.sqft ?? null) : null;
  const seedDontPrice = !!input.seed && (input.seed.dontPrice || input.seed.confidence === "DONT_PRICE");

  if (pos(seedArv)) {
    arvForPricer = seedArv;
    arvSource = "seed_renovated";
    arvConfidence = input.seed!.confidence === "STRONG" ? "STRONG" : "THIN";
    // $/sqft the seed actually applied (THIN biases to the low end).
    psfUsed = input.seed!.confidence === "THIN" && input.seed!.arvLowPerSqft != null
      ? input.seed!.arvLowPerSqft
      : input.seed!.renovatedPerSqft;
  } else if (seedDontPrice) {
    // The ZIP was evaluated and explicitly marked do-not-price (comps too few
    // / too noisy). Do NOT fall back to the contaminated stored ARV — with no
    // trusted ARV the pricer HOLDS for review (arvForPricer stays null; the
    // old list-fraction rail is retired).
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

  // ── PRE-SEND CORROBORATION GATE (allowlist) ──────────────────────────────
  // Even if every pricer guard passed, the computed opener must clear a set of
  // INDEPENDENT sanity signals to reach a seller. Any red flag → HOLD. This is
  // the reliability inversion: send only what corroborates, hold-and-ask on
  // everything else (927 Avon size extrapolation, 110 Leathers / 868 N Main
  // capped-on-inflated-ARV all fail here). See lib/opener-sanity-gate.
  const confidenceLabel: "STRONG" | "THIN" | "STORED" | null =
    arvSource === "none" ? null
    : arvConfidence === "STRONG" ? "STRONG"
    : arvConfidence === "THIN" ? "THIN"
    : arvSource === "stored" ? "STORED"
    : null;
  const corr = corroborateOpener({
    opener: result.opener,
    listPrice: input.listPrice ?? null,
    arvUsed: arvForPricer,
    sqft: input.sqft ?? null,
    cappedToList: result.cappedToList,
    arvConfidence: confidenceLabel,
    seed: input.seed ?? null,
    renovatedPerSqft: psfUsed,
  });

  let finalResult: PricerResult = result;
  if (!corr.corroborated && pos(result.opener)) {
    // Turn the computed (but un-corroborated) opener into a HOLD.
    finalResult = {
      ...result,
      opener: null,
      basis: "hold_no_value_basis",
      cappedToList: false,
      arvDistrusted: true,
      // A re-seed can cure a size/noise problem but not a fundamentally
      // over-list ARV; flag re-seed only when a fresh comp pull could help.
      flagReseed: corr.flags.some((f) => f === "size_extrapolation" || f === "psf_out_of_range"),
      detail: `HELD by corroboration gate [${corr.flags.join(", ")}] — ${corr.reasons.join("; ")} | (computed opener was $${result.opener.toLocaleString()}; ${result.detail})`,
    };
  }

  // Compact label for the Opener_Basis receipt.
  const basisLabel =
    !corr.corroborated && pos(result.opener) ? "hold_failed_corroboration"
    : finalResult.cappedToList ? "capped_to_list"
    : finalResult.basis === "hold_no_value_basis" ? "hold"
    : arvSource === "seed_renovated"
      ? (finalResult.overArvList ? "arv_buybox_seed_over_arv_list" : "arv_buybox_seed")
    : "arv_buybox_stored";

  return { result: finalResult, arvSource, arvUsed: arvForPricer, basisLabel, corroborationFlags: corr.flags };
}
