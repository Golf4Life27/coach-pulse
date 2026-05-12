// Phase 4A — ARV Intelligence Engine endpoint (stateless).
//
// GET /api/arv-intelligence/[zip]?address=...&city=...&state=...&beds=...&baths=...&sqft=...&condition_target=...
//
// Pulls RentCast sale comparables for the subject and runs them through
// the filter + ARV math in lib/arv-intelligence.ts. Returns ARV band,
// $/sqft, comps used + excluded, methodology notes, confidence. Writes
// nothing to Airtable — the Pricing Agent (Week 2) owns persistence.
//
// Briefing §17: numbers come from /lib/config/*.json so Alex can tune
// without redeploying logic.

import { NextResponse } from "next/server";
import { getSaleComparables } from "@/lib/rentcast";
import { computeArvIntelligence } from "@/lib/arv-intelligence";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 30;

const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const cache: Record<string, { data: unknown; ts: number }> = {};

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
  const condition_target = url.searchParams.get("condition_target");

  if (!zip || !/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: "Invalid ZIP" }, { status: 400 });
  }

  if (!process.env.RENTCAST_API_KEY) {
    return NextResponse.json({ error: "RENTCAST_API_KEY not set" }, { status: 500 });
  }

  const cacheKey = `arv:${zip}:${address}:${beds}:${baths}:${sqft}`;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  // RentCast comp lookup requires at minimum a usable address; if the
  // caller supplies only a ZIP, RentCast returns nothing. We surface the
  // gap as an explicit error rather than an empty success.
  if (!address) {
    return NextResponse.json(
      {
        error: "address query param required",
        detail: "RentCast sale-comparables resolves by full address. Caller must supply address (+ city + state) so the comp engine can anchor.",
        zip,
      },
      { status: 400 },
    );
  }

  let comps;
  try {
    comps = await getSaleComparables({
      address,
      city,
      state,
      zip,
      bedrooms: beds,
      bathrooms: baths,
      squareFootage: sqft,
    });
  } catch (err) {
    await audit({
      agent: "phase4a",
      event: "rentcast_error",
      inputSummary: { zip, address, beds, baths, sqft },
      error: String(err),
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      { error: "RentCast call failed", detail: String(err), zip },
      { status: 502 },
    );
  }

  const result = computeArvIntelligence(comps, {
    zip,
    beds,
    baths,
    sqft,
    condition_target,
  });

  await audit({
    agent: "phase4a",
    event: "arv_computed",
    inputSummary: { zip, address, beds, baths, sqft, condition_target },
    outputSummary: {
      arv_mid: result.arv_mid,
      avg_per_sqft: result.avg_per_sqft,
      comp_count_used: result.comp_count_used,
      comp_count_excluded: result.comp_count_excluded,
      confidence: result.confidence,
      filter_quality: result.filter_quality,
    },
    decision: result.confidence,
    ms: Date.now() - t0,
  });

  cache[cacheKey] = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}
