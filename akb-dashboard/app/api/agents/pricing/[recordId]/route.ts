// Pricing Agent — Phase 4A + 4B + 4C orchestrator
//
// GET /api/agents/pricing/[recordId]
//   ?skip_photos=1            skip Vision (Phase 4B)
//   ?rehab_mid_override=NNN   bypass Vision with manual rehab
//   ?rent_monthly_override=NN bypass RentCast rent for landlord track
//
// Composes the three stateless math layers in the order required for
// uplift to function correctly: 4B → 4A → 4C.
//
//   Phase 4B (Vision rehab) runs first because the renovated ARV uplift
//   in Phase 4A needs rehab_mid as input (otherwise Detroit/Memphis fall
//   back to as-is mirror; see lib/arv-intelligence.ts header).
//
//   Phase 4A (ARV intelligence) consumes rehab_mid from 4B and produces
//   both arv_as_is and arv_renovated bands.
//
//   Phase 4C (dual-track pricing) consumes ARV + rehab + rent and produces
//   flipper + landlord MAO with creative-finance flag.
//
// Failure modes per phase are best-effort: a missing photo doesn't kill
// the agent — 4A still runs on as-is ARV, 4C falls back to flipper-only.
// Each phase audit-logs its own result; the agent fires one wrap-up audit
// at the end with the composite outcome.
//
// Airtable write composes ALL phase outputs into a single PATCH via
// updateListingRecord → patchAndVerify, so the read-back-after-write
// drift detector covers every field.
//
// Currently writes the same fields the existing arv-validate +
// photo-analysis wrappers write (so the dashboard contract is preserved).
// Landlord track + creative-finance flag are surfaced in the response
// but NOT persisted — pending Alex confirmation of new Airtable field
// IDs.
//
// This agent does NOT set Pipeline_Stage or run any orchestrator gate.
// The Pre-Outreach Gate scaffolding (orchestrator spec §4 Gate 1) will
// be the layer ABOVE this agent and will call it as one step in the
// gate pipeline.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { getSaleComparables, getRentEstimate } from "@/lib/rentcast";
import { computeArvIntelligence } from "@/lib/arv-intelligence";
import { callRehabVision } from "@/lib/rehab-calibration";
import { computeDualTrackPricing } from "@/lib/pricing-math";
import { collectPhotos } from "@/lib/photo-sources";
import { audit } from "@/lib/audit-log";
import type { FieldDrift } from "@/lib/airtable-verify";

export const runtime = "nodejs";
export const maxDuration = 90;

type PhaseResult<T> =
  | { ok: true; result: T; error: null }
  | { ok: false; result: null; error: string };

function parseNum(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function mapArvConfidenceLabel(c: "HIGH" | "MED" | "LOW"): string {
  if (c === "HIGH") return "High";
  if (c === "MED") return "Medium";
  return "Low";
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const t0 = Date.now();
  const { recordId } = await params;
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", recordId }, { status: 400 });
  }

  const url = new URL(req.url);
  const skipPhotos = url.searchParams.get("skip_photos") === "1";
  const rehabOverride = parseNum(url.searchParams.get("rehab_mid_override"));
  const rentOverride = parseNum(url.searchParams.get("rent_monthly_override"));

  // ── Listing fetch ───────────────────────────────────────────────────
  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found", recordId }, { status: 404 });
  }
  if (!listing.address || !listing.city || !listing.state || !listing.zip) {
    return NextResponse.json(
      { error: "Listing missing address parts (address/city/state/zip required)", recordId },
      { status: 422 },
    );
  }

  // ── Phase 4B: Rehab calibration ────────────────────────────────────
  let phase4b: PhaseResult<Awaited<ReturnType<typeof callRehabVision>>>;
  if (rehabOverride != null) {
    phase4b = {
      ok: true,
      result: {
        zip: listing.zip,
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
        methodology_notes: [`rehab_mid_override = $${rehabOverride}`],
        computed_at: new Date().toISOString(),
      },
      error: null,
    };
  } else if (skipPhotos) {
    phase4b = { ok: false, result: null, error: "skip_photos=1 — Phase 4B skipped" };
  } else if (!process.env.ANTHROPIC_API_KEY) {
    phase4b = { ok: false, result: null, error: "ANTHROPIC_API_KEY not set" };
  } else {
    try {
      const fullAddress = [listing.address, listing.city, listing.state, listing.zip]
        .filter(Boolean)
        .join(", ");
      const photos = await collectPhotos({
        verificationUrl: listing.verificationUrl,
        fullAddress,
      });
      if (photos.length === 0) {
        phase4b = {
          ok: false,
          result: null,
          error: "No photos available (listing scrape + Street View both empty)",
        };
      } else {
        const result = await callRehabVision(
          {
            photos_urls: photos.map((p) => p.url),
            sqft: listing.buildingSqFt,
            zip: listing.zip,
            address: listing.address,
            beds: listing.bedrooms,
            baths: listing.bathrooms,
          },
          process.env.ANTHROPIC_API_KEY,
        );
        phase4b = { ok: true, result, error: null };
      }
    } catch (err) {
      phase4b = { ok: false, result: null, error: String(err) };
    }
  }

  // ── Phase 4A: ARV intelligence (uses 4B's rehab as uplift input) ───
  let phase4a: PhaseResult<ReturnType<typeof computeArvIntelligence>>;
  if (!process.env.RENTCAST_API_KEY) {
    phase4a = { ok: false, result: null, error: "RENTCAST_API_KEY not set" };
  } else {
    try {
      const comps = await getSaleComparables({
        address: listing.address,
        city: listing.city,
        state: listing.state,
        zip: listing.zip,
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        squareFootage: listing.buildingSqFt,
      });
      const result = computeArvIntelligence(comps, {
        zip: listing.zip,
        beds: listing.bedrooms,
        baths: listing.bathrooms,
        sqft: listing.buildingSqFt,
        condition_target: "renovated", // agent default — offer math targets renovated value
        rehab_mid: phase4b.ok ? phase4b.result.rehab_mid : null,
      });
      phase4a = { ok: true, result, error: null };
    } catch (err) {
      phase4a = { ok: false, result: null, error: String(err) };
    }
  }

  // ── Rent (Phase 4C input) ──────────────────────────────────────────
  let rent_monthly: number | null = rentOverride;
  let rent_source = "override";
  let rent_error: string | null = null;
  if (rent_monthly == null) {
    if (!process.env.RENTCAST_API_KEY) {
      rent_error = "RENTCAST_API_KEY not set — landlord track will be skipped";
    } else {
      try {
        const r = await getRentEstimate({
          address: listing.address,
          city: listing.city,
          state: listing.state,
          zip: listing.zip,
          bedrooms: listing.bedrooms,
          bathrooms: listing.bathrooms,
          squareFootage: listing.buildingSqFt,
        });
        rent_monthly = r.rent;
        rent_source = "rentcast";
        if (rent_monthly == null) rent_error = "RentCast returned null rent";
      } catch (err) {
        rent_error = String(err);
      }
    }
  }

  // ── Phase 4C: Dual-track pricing ───────────────────────────────────
  let phase4c: PhaseResult<ReturnType<typeof computeDualTrackPricing>>;
  if (!phase4a.ok || phase4a.result.arv_mid == null) {
    phase4c = { ok: false, result: null, error: "Cannot run pricing — no ARV from Phase 4A" };
  } else if (!phase4b.ok || phase4b.result.rehab_mid == null) {
    phase4c = { ok: false, result: null, error: "Cannot run pricing — no rehab from Phase 4B" };
  } else {
    try {
      const result = computeDualTrackPricing({
        zip: listing.zip,
        arv_mid: phase4a.result.arv_mid,
        rehab_mid: phase4b.result.rehab_mid,
        rent_monthly,
      });
      phase4c = { ok: true, result, error: null };
    } catch (err) {
      phase4c = { ok: false, result: null, error: String(err) };
    }
  }

  // ── Airtable write ─────────────────────────────────────────────────
  // Compose every successful phase's outputs into one PATCH.
  // Field names match the existing arv-validate + photo-analysis writes
  // so the dashboard contract is preserved. The patchAndVerify layer
  // catches any select-field drift on the way out.
  //
  // PRINCIPLE: only write fields that have a real computed value. When
  // a phase produced null (e.g., Phase 4A returned 0 usable comps), we
  // do NOT overwrite the existing Airtable value with null — better to
  // leave the stale value than corrupt it. The "ARV_Validated_At"
  // stamp also only updates when we actually validated.
  const fieldsToWrite: Record<string, unknown> = {};
  const nowIso = new Date().toISOString();

  if (phase4a.ok && phase4a.result.arv_mid != null) {
    fieldsToWrite.Real_ARV_Low = phase4a.result.arv_low;
    fieldsToWrite.Real_ARV_High = phase4a.result.arv_high;
    fieldsToWrite.Real_ARV_Median = phase4a.result.arv_mid;
    fieldsToWrite.ARV_Confidence = mapArvConfidenceLabel(phase4a.result.confidence);
    fieldsToWrite.ARV_Validated_At = nowIso;
  }

  if (phase4b.ok && rehabOverride == null && phase4b.result.rehab_mid != null) {
    // Skip Airtable rehab fields when we used an override — the override
    // is a math input only, not a persistence-worthy value.
    fieldsToWrite.Est_Rehab_Low = phase4b.result.rehab_low;
    fieldsToWrite.Est_Rehab_Mid = phase4b.result.rehab_mid;
    fieldsToWrite.Est_Rehab_High = phase4b.result.rehab_high;
    // The Investor_MAO + Your_MAO Airtable formulas reference Est_Rehab
    // (fldmup8SvMky9eyag), NOT Est_Rehab_Mid (fldyDCVwvn9jfdiES). Write
    // BOTH — Est_Rehab so the formula computes correctly, Est_Rehab_Mid
    // stays as the explicit Phase 4B audit-trail field. Discovered 5/13
    // during formula-field investigation.
    fieldsToWrite.Est_Rehab = phase4b.result.rehab_mid;
    fieldsToWrite.Rehab_Confidence_Score = phase4b.result.confidence;
    fieldsToWrite.Rehab_Red_Flags = phase4b.result.red_flags.join(", ") || "";
    fieldsToWrite.Rehab_Estimated_At = nowIso;
  }

  // Investor_MAO / Your_MAO / Auto_Approve_v2 are FORMULA fields on
  // Listings_V1 (verified 5/13 via Airtable schema). Writes return 422
  // INVALID_VALUE_FOR_COLUMN and — because PATCH is atomic — kill every
  // other field in the same request. The dashboard reads the formula
  // output; the formula computes correctly once Real_ARV_Median +
  // Est_Rehab + Buyer_Profit_Target + Wholesale_Fee_Target are set.
  // Pricing Agent's flipper-track math is informational here (returned
  // in the response) — Airtable formulas are the canonical persistence.
  //
  // Auto_Approve_v2 likewise — formula gates on Real_ARV_Median > 0 AND
  // Your_MAO >= $20K. No agent write needed.

  let airtableDrift: FieldDrift[] = [];
  let airtableError: string | null = null;
  if (Object.keys(fieldsToWrite).length > 0) {
    try {
      airtableDrift = await updateListingRecord(recordId, fieldsToWrite);
    } catch (err) {
      airtableError = String(err);
    }
  }

  // ── Composite agent status + audit ─────────────────────────────────
  const phaseOks = [phase4a.ok, phase4b.ok, phase4c.ok];
  const allPhasesOk = phaseOks.every((x) => x);
  const writeOk = airtableError == null;
  const driftFlagged = airtableDrift.length > 0;

  // confirmed_success: every phase produced a result AND Airtable write
  //                    landed clean (no drift)
  // confirmed_failure: write threw (state didn't reach Airtable)
  // uncertain:         partial phase success, OR drift on the write
  const overallStatus =
    !writeOk
      ? "confirmed_failure"
      : allPhasesOk && !driftFlagged
        ? "confirmed_success"
        : "uncertain";

  await audit({
    agent: "pricing-agent",
    event: "agent_run",
    status: overallStatus,
    recordId,
    inputSummary: {
      address: listing.address,
      zip: listing.zip,
      sqft: listing.buildingSqFt,
      skip_photos: skipPhotos,
      rehab_override: rehabOverride,
      rent_override: rentOverride,
    },
    outputSummary: {
      phase_4a_ok: phase4a.ok,
      phase_4b_ok: phase4b.ok,
      phase_4c_ok: phase4c.ok,
      airtable_write_ok: writeOk,
      drift_count: airtableDrift.length,
      arv_mid: phase4a.ok ? phase4a.result.arv_mid : null,
      arv_method: phase4a.ok ? phase4a.result.arv_method : null,
      rehab_mid: phase4b.ok ? phase4b.result.rehab_mid : null,
      your_mao_flipper: phase4c.ok ? phase4c.result.your_mao_flipper : null,
      your_mao_landlord: phase4c.ok ? phase4c.result.your_mao_landlord : null,
      recommended_track: phase4c.ok ? phase4c.result.recommended_track : null,
      creative_finance_flag: phase4c.ok ? phase4c.result.creative_finance_flag : null,
    },
    decision: overallStatus,
    error: airtableError ?? undefined,
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    recordId,
    overall_status: overallStatus,
    phase_4a: phase4a,
    phase_4b: phase4b,
    phase_4c: {
      ...phase4c,
      rent_monthly,
      rent_source,
      rent_error,
    },
    airtable_write: {
      ok: writeOk,
      fields_written: Object.keys(fieldsToWrite),
      drift: airtableDrift,
      error: airtableError,
    },
    computed_at: nowIso,
    elapsed_ms: Date.now() - t0,
  });
}
