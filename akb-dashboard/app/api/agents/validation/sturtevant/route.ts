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

  const vcase = getValidationCase("sturtevant");
  if (!vcase) {
    return NextResponse.json({ error: "sturtevant validation case missing" }, { status: 500 });
  }

  const subject = {
    zip: vcase.zip,
    beds: vcase.subject.beds ?? null,
    baths: vcase.subject.baths ?? null,
    sqft: vcase.subject.sqft ?? null,
    condition_target: vcase.subject.condition ?? null,
  };

  // ── Phase 4A: ARV ───────────────────────────────────────────────────
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
      arvResult = computeArvIntelligence(comps, subject);
    } catch (err) {
      arvError = String(err);
    }
  }

  // ── Phase 4B: Rehab ─────────────────────────────────────────────────
  let rehabResult: Awaited<ReturnType<typeof callRehabVision>> | null = null;
  let rehabError: string | null = null;
  if (skipPhotos) {
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
  const checks = {
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
    agent: "validation-sturtevant",
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
    },
    outputSummary: {
      arv_mid: arvResult?.arv_mid ?? null,
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
