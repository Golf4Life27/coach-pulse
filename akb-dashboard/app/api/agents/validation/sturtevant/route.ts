// Sturtevant validation harness — Phase 4C anchor (Briefing §11, Bible v3
// dual-track example).
//
// Walks 1973 Sturtevant St through Phase 4A → 4B → 4C end-to-end and
// validates the qualitative expectations encoded in validation_cases.json
// (both tracks compute, creative-finance flag fires when landlord > flipper).
//
// GET /api/agents/validation/sturtevant
//   ?skip_photos=1     skip Vision (Phase 4B) — useful for cost-free smoke
//   ?rent_monthly=NNN  override RentCast rent (useful when Detroit AVM thin)
//
// NOTE: Sturtevant is in active negotiation. Harness reads only — no
// Airtable writes, no outreach.

import { NextResponse } from "next/server";
import { getSaleComparables, getRentEstimate } from "@/lib/rentcast";
import { computeArvIntelligence } from "@/lib/arv-intelligence";
import { callRehabVision } from "@/lib/rehab-calibration";
import { collectPhotos } from "@/lib/photo-sources";
import { computeDualTrackPricing } from "@/lib/pricing-math";
import { getValidationCase } from "@/lib/config";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 90;

function parseNum(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const skipPhotos = url.searchParams.get("skip_photos") === "1";
  const rentOverride = parseNum(url.searchParams.get("rent_monthly"));
  // rehab_mid override lets us run the 4A uplift path without burning
  // Vision tokens — useful for repeated math validation on the same case.
  const rehabOverride = parseNum(url.searchParams.get("rehab_mid"));

  const vcase = getValidationCase("sturtevant");
  if (!vcase) {
    return NextResponse.json({ error: "sturtevant validation case missing" }, { status: 500 });
  }

  const subject = {
    zip: vcase.zip,
    beds: vcase.subject.beds ?? null,
    baths: vcase.subject.baths ?? null,
    sqft: vcase.subject.sqft ?? null,
  };

  // ── Phase 4B: Rehab (runs BEFORE 4A so the uplift model has rehab_mid)
  // Detroit's Phase 4A uplift path needs rehab as input to produce the
  // renovated ARV. Order is now 4B → 4A → 4C. See lib/arv-intelligence.ts.
  let rehabResult: Awaited<ReturnType<typeof callRehabVision>> | null = null;
  let rehabError: string | null = null;
  if (rehabOverride != null) {
    rehabResult = {
      zip: vcase.zip,
      market: "override",
      market_multiplier: 1,
      condition_overall: "Poor",
      rehab_low: rehabOverride,
      rehab_mid: rehabOverride,
      rehab_high: rehabOverride,
      confidence: 70,
      line_items: [],
      red_flags: [],
      photo_count: 0,
      anchor_rate_per_sqft: 0,
      vision_model: "override",
      methodology_notes: [`rehab_mid override = $${rehabOverride}`],
      computed_at: new Date().toISOString(),
    };
  } else if (skipPhotos) {
    rehabError = "skip_photos=1 — Phase 4B skipped";
  } else if (!process.env.ANTHROPIC_API_KEY) {
    rehabError = "ANTHROPIC_API_KEY not set — Phase 4B skipped";
  } else {
    try {
      const photos = await collectPhotos({
        verificationUrl: null,
        fullAddress: `${vcase.address}, ${vcase.city}, ${vcase.state}, ${vcase.zip}`,
      });
      if (photos.length === 0) {
        rehabError = "No photos available (Street View + listing scrape both empty).";
      } else {
        rehabResult = await callRehabVision(
          {
            photos_urls: photos.map((p) => p.url),
            sqft: subject.sqft,
            zip: vcase.zip,
            address: vcase.address,
            beds: subject.beds,
            baths: subject.baths,
          },
          process.env.ANTHROPIC_API_KEY,
        );
      }
    } catch (err) {
      rehabError = String(err);
    }
  }

  // ── Phase 4A: ARV (after rehab so uplift can fire)
  let arvResult: ReturnType<typeof computeArvIntelligence> | null = null;
  let arvError: string | null = null;
  if (!process.env.RENTCAST_API_KEY) {
    arvError = "RENTCAST_API_KEY not set — Phase 4A skipped";
  } else {
    try {
      const comps = await getSaleComparables({
        address: vcase.address,
        city: vcase.city,
        state: vcase.state,
        zip: vcase.zip,
        bedrooms: subject.beds,
        bathrooms: subject.baths,
        squareFootage: subject.sqft,
      });
      arvResult = computeArvIntelligence(comps, {
        ...subject,
        condition_target: "renovated", // agent default
        rehab_mid: rehabResult?.rehab_mid ?? null,
      });
    } catch (err) {
      arvError = String(err);
    }
  }

  // ── Rent (Phase 4C input) ───────────────────────────────────────────
  let rent_monthly: number | null = rentOverride;
  let rent_error: string | null = null;
  let rent_source = "override";
  if (rent_monthly == null) {
    if (!process.env.RENTCAST_API_KEY) {
      rent_error = "RENTCAST_API_KEY not set — landlord track will be skipped";
    } else {
      try {
        const r = await getRentEstimate({
          address: vcase.address,
          city: vcase.city,
          state: vcase.state,
          zip: vcase.zip,
          bedrooms: subject.beds,
          bathrooms: subject.baths,
          squareFootage: subject.sqft,
        });
        rent_monthly = r.rent;
        rent_source = "rentcast";
        if (rent_monthly == null) {
          rent_error = "RentCast returned null rent";
        }
      } catch (err) {
        rent_error = String(err);
      }
    }
  }

  // ── Phase 4C: Dual-track pricing ────────────────────────────────────
  let pricingResult: ReturnType<typeof computeDualTrackPricing> | null = null;
  let pricingError: string | null = null;
  if (!arvResult || arvResult.arv_mid == null) {
    pricingError = "Cannot run pricing — no ARV from Phase 4A";
  } else if (!rehabResult || rehabResult.rehab_mid == null) {
    pricingError = "Cannot run pricing — no rehab from Phase 4B (use ?skip_photos=0 + valid ANTHROPIC_API_KEY)";
  } else {
    pricingResult = computeDualTrackPricing({
      zip: vcase.zip,
      arv_mid: arvResult.arv_mid,
      rehab_mid: rehabResult.rehab_mid,
      rent_monthly,
    });
  }

  // ── Grading ─────────────────────────────────────────────────────────
  // arv_renovated_target_band added 5/12: Briyana's $145K street comp
  // anchors the band. Working tolerance ±10% gives [130500, 159500].
  const ARV_RENOVATED_TARGET_LOW = 130_500;
  const ARV_RENOVATED_TARGET_HIGH = 159_500;

  const arvRenovatedMid = arvResult?.arv_renovated.mid ?? null;
  const arvMethodIsUplift =
    arvResult?.arv_renovated.method === "uplift_model" ||
    arvResult?.arv_renovated.method === "consensus";

  const checks = {
    arv_renovated_lands_in_target_band:
      arvRenovatedMid == null
        ? null
        : arvRenovatedMid >= ARV_RENOVATED_TARGET_LOW &&
          arvRenovatedMid <= ARV_RENOVATED_TARGET_HIGH,
    arv_uplift_path_fires_for_detroit:
      arvResult == null ? null : arvMethodIsUplift,
    pricing_run_succeeds: pricingResult != null,
    both_tracks_compute_when_rent_available:
      rent_monthly == null || (pricingResult?.flipper != null && pricingResult?.landlord != null),
    creative_finance_flag_fires_when_delta_above_threshold:
      pricingResult == null
        ? null
        : pricingResult.delta_landlord_minus_flipper == null
          ? null // can't grade without landlord track
          : pricingResult.delta_landlord_minus_flipper > 5000
            ? pricingResult.creative_finance_flag === true
            : pricingResult.creative_finance_flag === false,
  };

  const passedKnown = Object.values(checks).filter((v) => v === true).length;
  const failedKnown = Object.values(checks).filter((v) => v === false).length;
  const overall =
    failedKnown > 0 ? "fail" : passedKnown > 0 ? "pass" : "incomplete";

  await audit({
    agent: "appraiser",
    event: "harness_run",
    status:
      overall === "pass"
        ? "confirmed_success"
        : overall === "fail"
          ? "confirmed_failure"
          : "uncertain",
    inputSummary: {
      address: vcase.address,
      zip: vcase.zip,
      skip_photos: skipPhotos,
      rent_override: rentOverride,
      rehab_override: rehabOverride,
    },
    outputSummary: {
      arv_mid: arvResult?.arv_mid ?? null,
      arv_method: arvResult?.arv_method ?? null,
      arv_as_is_mid: arvResult?.arv_as_is.mid ?? null,
      arv_renovated_mid: arvResult?.arv_renovated.mid ?? null,
      cross_method_disagreement: arvResult?.cross_method_disagreement.fired ?? null,
      rehab_mid: rehabResult?.rehab_mid ?? null,
      rent_monthly,
      your_mao_flipper: pricingResult?.your_mao_flipper ?? null,
      your_mao_landlord: pricingResult?.your_mao_landlord ?? null,
      recommended_track: pricingResult?.recommended_track ?? null,
      creative_finance_flag: pricingResult?.creative_finance_flag ?? null,
      checks,
    },
    decision: overall,
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    case: vcase.id,
    overall,
    checks,
    phase_4a: { actual: arvResult, error: arvError },
    phase_4b: { actual: rehabResult, error: rehabError },
    phase_4c: {
      actual: pricingResult,
      error: pricingError,
      rent_monthly,
      rent_source,
      rent_error,
    },
    elapsed_ms: Date.now() - t0,
  });
}
