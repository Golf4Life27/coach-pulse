// Phase 4C — Dual-Track Pricing Intelligence endpoint (stateless).
//
// GET /api/pricing-intelligence/[zip]?address=...&city=...&state=...&beds=...&baths=...&sqft=...&arv_mid=...&rehab_mid=...&rent_monthly=...
//
// Combines Phase 4A (ARV) and Phase 4B (Rehab) outputs into both buyer
// tracks. Rent is fetched from RentCast unless overridden via the
// rent_monthly query param (lets callers bypass RentCast for testing or
// manual rent override).
//
// Writes nothing to Airtable. The Pricing Agent (Week 3+) will own
// persistence; this endpoint is the math source of truth.
//
// Per the Positive Confirmation Principle: empty rent data is a signal,
// not silent zero. When RentCast fails OR returns null rent, the
// landlord track is explicitly skipped and surfaced in
// methodology_notes — recommended_track falls back to flipper-only.

import { NextResponse } from "next/server";
import { getRentEstimate } from "@/lib/rentcast";
import { computeDualTrackPricing } from "@/lib/pricing-math";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 30;

function parseNum(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ zip: string }> },
) {
  const t0 = Date.now();
  const { zip } = await params;
  const url = new URL(req.url);
  const address = url.searchParams.get("address") ?? "";
  const city = url.searchParams.get("city") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const beds = parseNum(url.searchParams.get("beds"));
  const baths = parseNum(url.searchParams.get("baths"));
  const sqft = parseNum(url.searchParams.get("sqft"));
  const arv_mid = parseNum(url.searchParams.get("arv_mid"));
  const rehab_mid = parseNum(url.searchParams.get("rehab_mid"));
  const rent_override = parseNum(url.searchParams.get("rent_monthly"));

  if (!zip || !/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: "Invalid ZIP" }, { status: 400 });
  }
  if (arv_mid == null || arv_mid <= 0) {
    return NextResponse.json(
      { error: "arv_mid query param required (run Phase 4A first)" },
      { status: 400 },
    );
  }
  if (rehab_mid == null || rehab_mid < 0) {
    return NextResponse.json(
      { error: "rehab_mid query param required (run Phase 4B first)" },
      { status: 400 },
    );
  }

  // ── Rent resolution ────────────────────────────────────────────────
  let rent_monthly: number | null = rent_override ?? null;
  let rent_source = "override";
  let rent_error: string | null = null;
  if (rent_monthly == null) {
    if (!process.env.RENTCAST_API_KEY) {
      rent_error = "RENTCAST_API_KEY not set — landlord track will be skipped.";
    } else if (!address) {
      rent_error = "address required for RentCast rent lookup — landlord track will be skipped.";
    } else {
      try {
        const r = await getRentEstimate({
          address,
          city,
          state,
          zip,
          bedrooms: beds,
          bathrooms: baths,
          squareFootage: sqft,
        });
        rent_monthly = r.rent;
        rent_source = "rentcast";
        if (rent_monthly == null) {
          rent_error = "RentCast returned null rent — landlord track will be skipped.";
        }
      } catch (err) {
        rent_error = `RentCast rent call failed: ${String(err)}`;
      }
    }
  }

  // ── Math ────────────────────────────────────────────────────────────
  const result = computeDualTrackPricing({
    zip,
    arv_mid,
    rehab_mid,
    rent_monthly,
  });

  if (rent_error) result.methodology_notes.push(rent_error);
  result.methodology_notes.push(
    `Rent source: ${rent_source}${rent_monthly != null ? ` ($${rent_monthly}/mo)` : ""}.`,
  );

  await audit({
    agent: "phase4c",
    event: "dual_track_computed",
    status: "confirmed_success",
    inputSummary: { zip, address, arv_mid, rehab_mid, rent_monthly, rent_source },
    outputSummary: {
      recommended_track: result.recommended_track,
      creative_finance_flag: result.creative_finance_flag,
      your_mao_flipper: result.your_mao_flipper,
      your_mao_landlord: result.your_mao_landlord,
      delta: result.delta_landlord_minus_flipper,
    },
    decision: result.recommended_track,
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ...result,
    rent_source,
    rent_error,
  });
}
