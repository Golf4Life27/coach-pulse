// Phase 4B — Rehab Calibration endpoint (stateless).
//
// POST /api/rehab-calibration
// Body: { photos_urls: string[], sqft, zip, address?, beds?, baths?, year_built? }
//
// Calls Anthropic Vision against the Bible v3 §4.2 4-tier × per-market
// multiplier model. Returns rehab band, condition, per-category line
// items, red flags. Writes nothing to Airtable — the photo-analysis
// wrapper handles persistence.

import { NextResponse } from "next/server";
import { callRehabVision } from "@/lib/rehab-calibration";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RequestBody {
  photos_urls?: unknown;
  sqft?: unknown;
  zip?: unknown;
  address?: unknown;
  beds?: unknown;
  baths?: unknown;
  year_built?: unknown;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && !isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

export async function POST(req: Request) {
  const t0 = Date.now();
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const photos_urls = Array.isArray(body.photos_urls)
    ? (body.photos_urls as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const zip = typeof body.zip === "string" ? body.zip.trim() : "";
  const sqft = asNum(body.sqft);

  if (!zip || !/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: "zip required (5 digits)" }, { status: 400 });
  }
  if (photos_urls.length === 0) {
    return NextResponse.json({ error: "photos_urls required (non-empty)" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  try {
    const result = await callRehabVision(
      {
        photos_urls,
        sqft,
        zip,
        address: typeof body.address === "string" ? body.address : undefined,
        beds: asNum(body.beds),
        baths: asNum(body.baths),
        year_built: asNum(body.year_built),
      },
      apiKey,
    );

    await audit({
      agent: "phase4b",
      event: "rehab_computed",
      status: "confirmed_success",
      inputSummary: { zip, sqft, photo_count: photos_urls.length },
      outputSummary: {
        condition_overall: result.condition_overall,
        rehab_mid: result.rehab_mid,
        market_multiplier: result.market_multiplier,
        confidence: result.confidence,
        red_flags: result.red_flags,
      },
      decision: result.condition_overall,
      ms: Date.now() - t0,
    });

    return NextResponse.json(result);
  } catch (err) {
    await audit({
      agent: "phase4b",
      event: "rehab_error",
      status: "confirmed_failure",
      inputSummary: { zip, sqft, photo_count: photos_urls.length },
      error: String(err),
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      { error: "Rehab vision call failed", detail: String(err) },
      { status: 502 },
    );
  }
}
