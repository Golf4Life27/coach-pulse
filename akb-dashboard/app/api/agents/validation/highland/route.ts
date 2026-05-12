// Highland validation harness — Phase 4 Test 1 (Briefing §11).
//
// Runs the Highland address (1219 E Highland Blvd, San Antonio 78210)
// through Phase 4A and Phase 4B and grades the output against
// validation_cases.json expectations. Used in Week 1 sign-off and as a
// regression smoke test going forward.
//
// GET /api/agents/validation/highland?skip_photos=1 to skip the Vision
// call when running locally without ANTHROPIC_API_KEY.
//
// NOTE: Highland is on the never-resurface list (walked 4/30/2026). This
// route reads RentCast + Street View only; it does not touch Airtable
// and never triggers outreach.

import { NextResponse } from "next/server";
import { getSaleComparables } from "@/lib/rentcast";
import { computeArvIntelligence } from "@/lib/arv-intelligence";
import { callRehabVision } from "@/lib/rehab-calibration";
import { collectPhotos } from "@/lib/photo-sources";
import { getValidationCase } from "@/lib/config";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 60;

function withinRange(actual: number | null | undefined, low: number, high: number): boolean {
  if (actual == null) return false;
  return actual >= low && actual <= high;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const skipPhotos = url.searchParams.get("skip_photos") === "1";

  const vcase = getValidationCase("highland");
  if (!vcase) {
    return NextResponse.json({ error: "highland validation case missing" }, { status: 500 });
  }

  const exp = vcase.expectations as {
    arv_low: number;
    arv_mid: number;
    arv_high: number;
    rehab_low: number;
    rehab_mid: number;
    rehab_high: number;
    your_mao_target: number;
    your_mao_tolerance: number;
  };

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
    arvError = "RENTCAST_API_KEY not set — skipping Phase 4A leg";
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
    rehabError = "skip_photos=1 — skipping Phase 4B leg";
  } else if (!process.env.ANTHROPIC_API_KEY) {
    rehabError = "ANTHROPIC_API_KEY not set — skipping Phase 4B leg";
  } else {
    try {
      const photos = await collectPhotos({
        verificationUrl: null,
        fullAddress: `${vcase.address}, ${vcase.city}, ${vcase.state}, ${vcase.zip}`,
      });
      if (photos.length === 0) {
        rehabError =
          "No photos available (Street View + listing scrape both empty). Check GOOGLE_MAPS_API_KEY.";
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

  // ── Grading ─────────────────────────────────────────────────────────
  const arvPass = arvResult
    ? withinRange(arvResult.arv_mid, exp.arv_low, exp.arv_high)
    : null;
  const rehabPass = rehabResult
    ? withinRange(rehabResult.rehab_mid, exp.rehab_low, exp.rehab_high)
    : null;

  const overall =
    arvPass === true && rehabPass === true
      ? "pass"
      : arvPass === false || rehabPass === false
        ? "fail"
        : "incomplete";

  await audit({
    agent: "validation-highland",
    event: "harness_run",
    status:
      overall === "pass"
        ? "confirmed_success"
        : overall === "fail"
          ? "confirmed_failure"
          : "uncertain",
    inputSummary: { address: vcase.address, zip: vcase.zip, skip_photos: skipPhotos },
    outputSummary: {
      arv_mid: arvResult?.arv_mid ?? null,
      rehab_mid: rehabResult?.rehab_mid ?? null,
      arv_pass: arvPass,
      rehab_pass: rehabPass,
      arv_error: arvError,
      rehab_error: rehabError,
    },
    decision: overall,
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    case: vcase.id,
    overall,
    phase_4a: {
      pass: arvPass,
      expected_arv_low: exp.arv_low,
      expected_arv_mid: exp.arv_mid,
      expected_arv_high: exp.arv_high,
      actual: arvResult,
      error: arvError,
    },
    phase_4b: {
      pass: rehabPass,
      expected_rehab_low: exp.rehab_low,
      expected_rehab_mid: exp.rehab_mid,
      expected_rehab_high: exp.rehab_high,
      actual: rehabResult,
      error: rehabError,
    },
    note: "Phase 4C (dual-track MAO) lands in Week 2. Your_MAO target ${target}±${tol} not graded this run."
      .replace("${target}", String(exp.your_mao_target))
      .replace("${tol}", String(exp.your_mao_tolerance)),
    elapsed_ms: Date.now() - t0,
  });
}
