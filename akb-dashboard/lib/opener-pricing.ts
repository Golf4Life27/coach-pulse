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
import { buildDerivation, type OpenerDerivation } from "@/lib/pricing/opener-derivation";
import { OFFER_ROUND_STEP_USD } from "@/lib/pricing/offer-rounding";
import { PLACEHOLDER_REHAB_HOLD_REASON } from "@/lib/pricing/vision-queue";

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
  /** THE RECEIPT (2026-08-06 audit). Every term the formula consumed, so the
   *  number can be recomputed cold from the record instead of reverse-
   *  engineered. Emitted HERE, at the point of computation, so it can never
   *  drift from the opener it explains. */
  derivation: OpenerDerivation;
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
    bestCaseOpener: result.bestCaseOpener,
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

  // ── PLACEHOLDER-REHAB HOLD (256 Westchester, operator 2026-07-31) ────────
  // LAST, after the corroboration gate has had its say — a record that failed
  // corroboration keeps THAT reason (an ARV problem vision cannot fix; routing
  // it to a vision drain would park it somewhere that can never clear it).
  // What lands here is a number that survived every guard and is wrong for
  // exactly one reason: its rehab was invented.
  //
  //   ARV     ≈ $223,750  (correct — the agent said $230k)
  //   rehab   = 0.30×ARV = $67,125  on a house needing $0
  //   opener  = $74,500   texted against a $234,900 turnkey listing
  //
  // Rehab is the largest term after ARV; guessing it is guessing the offer.
  // HOLD and route to the vision queue — MACHINE work, drained by cron, and
  // deliberately not an h2_opener_hold operator proposal.
  let heldForVision = false;
  if (pos(finalResult.opener) && finalResult.placeholderRehab === true) {
    heldForVision = true;
    finalResult = {
      ...finalResult,
      opener: null,
      basis: "hold_no_value_basis",
      cappedToList: false,
      detail:
        `${PLACEHOLDER_REHAB_HOLD_REASON} — computed opener $${finalResult.opener.toLocaleString()} rests on a ` +
        `placeholder rehab ($${(finalResult.rehabUsed ?? 0).toLocaleString()}, no vision read). ` +
        `Number is otherwise sendable; the renovation is invented. Run vision, then price. | ${finalResult.detail}`,
    };
  }

  // Compact label for the Opener_Basis receipt. (capped_to_list is retired as
  // a producible label — ruling recmy2Vwp1wMA1Vs8; it survives only on legacy
  // records. An over-threshold opener now surfaces as hold_over_list_tripwire.)
  const basisLabel =
    !corr.corroborated && pos(result.opener) ? "hold_failed_corroboration"
    : heldForVision ? PLACEHOLDER_REHAB_HOLD_REASON
    : finalResult.overListTripwire ? "hold_over_list_tripwire"
    : finalResult.basis === "hold_no_value_basis" ? "hold"
    : arvSource === "seed_renovated"
      ? (finalResult.overArvList ? "arv_buybox_seed_over_arv_list" : "arv_buybox_seed")
    : "arv_buybox_stored";

  const derivation = buildDerivation({
    opener: finalResult.opener,
    basis: basisLabel,
    psf: psfUsed ?? null,
    sqft: input.sqft ?? null,
    arv: arvForPricer,
    arvSource,
    arvPctMax: input.arvPctMax ?? null,
    rehab: finalResult.rehabUsed,
    rehabPlaceholder: finalResult.placeholderRehab === true,
    fee: input.wholesaleFee ?? null,
    anchor: finalResult.anchorPct,
    ceiling: finalResult.ceiling,
    roundTo: OFFER_ROUND_STEP_USD,
    flags: corr.flags,
  });

  return { result: finalResult, arvSource, arvUsed: arvForPricer, basisLabel, corroborationFlags: corr.flags, derivation };
}
