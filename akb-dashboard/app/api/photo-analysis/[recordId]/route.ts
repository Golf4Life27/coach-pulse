// Record-based rehab/photo wrapper. The Vision call moved to
// /api/rehab-calibration (stateless, source of truth for rehab math).
//
// This route stays for dashboard backward-compat: it reads the listing
// from Airtable, collects photos via the existing photo-sources pipe
// (Redfin + Street View), calls the stateless rehab library, maps the
// Bible v3 8-category output back to the dashboard's legacy line-item
// categories, and persists to the same Airtable fields.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { collectPhotos } from "@/lib/photo-sources";
import { callRehabVision, type RehabCategoryName } from "@/lib/rehab-calibration";
import { audit } from "@/lib/audit-log";
import type {
  PhotoAnalysisResult,
  PhotoLineItem,
  PhotoLineItemCategory,
  PropertyCondition,
} from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE_TTL_MS = 24 * 60 * 60_000;
const cache: Record<string, { data: PhotoAnalysisResult; ts: number }> = {};

// Bible v3 §4.2 introduces 8 finer-grained categories; the dashboard's
// PhotoLineItem type uses 10 legacy categories. Map for backward-compat;
// the Bible-v3 label is preserved at the start of `notes`.
const CATEGORY_MAP: Record<RehabCategoryName, PhotoLineItemCategory> = {
  Exterior: "exterior",
  Roof: "roof",
  Paint: "other",
  Flooring: "interior",
  Kitchen: "kitchen",
  Bathrooms: "bathroom",
  HVAC: "hvac",
  Electrical: "electrical",
};

// Bible v3 Condition values overlap PropertyCondition but include
// "Disrepair"; PropertyCondition supports it already, so direct cast is
// safe but we narrow defensively.
function asPropertyCondition(c: string): PropertyCondition {
  const allowed: PropertyCondition[] = ["Good", "Fair", "Average", "Poor", "Disrepair"];
  return (allowed as string[]).includes(c) ? (c as PropertyCondition) : "Poor";
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const t0 = Date.now();
  const { recordId } = await params;
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", recordId }, { status: 400 });
  }

  const cached = cache[recordId];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found", recordId }, { status: 404 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  const fullAddress = [listing.address, listing.city, listing.state, listing.zip]
    .filter(Boolean)
    .join(", ");

  const photos = await collectPhotos({
    verificationUrl: listing.verificationUrl,
    fullAddress,
  });

  if (photos.length === 0) {
    return NextResponse.json(
      {
        error: "No photos available for analysis",
        detail:
          "Both listing-photo scrape (ScraperAPI) and Street View collection returned 0 photos. Check SCRAPER_API_KEY, GOOGLE_MAPS_API_KEY, and Verification_URL.",
        recordId,
      },
      { status: 422 },
    );
  }

  let rehab;
  try {
    rehab = await callRehabVision(
      {
        photos_urls: photos.map((p) => p.url),
        sqft: listing.buildingSqFt,
        zip: listing.zip,
        address: listing.address,
        beds: listing.bedrooms,
        baths: listing.bathrooms,
      },
      apiKey,
    );
  } catch (err) {
    console.error(`[photo-analysis] vision call failed for ${recordId}:`, err);
    return NextResponse.json(
      { error: "Rehab vision call failed", detail: String(err), recordId },
      { status: 502 },
    );
  }

  const line_items: PhotoLineItem[] = rehab.line_items.map((li) => ({
    category: CATEGORY_MAP[li.category],
    estimate_low: li.estimate_low,
    estimate_high: li.estimate_high,
    confidence: li.confidence,
    notes: li.notes ? `[${li.category}] ${li.notes}` : `[${li.category}]`,
  }));

  const photo_sources = Array.from(new Set(photos.map((p) => p.source))) as Array<
    "rentcast" | "firecrawl" | "listing" | "streetview"
  >;

  const result: PhotoAnalysisResult = {
    recordId,
    condition_overall: asPropertyCondition(rehab.condition_overall),
    rehab_estimate_low: rehab.rehab_low,
    rehab_estimate_mid: rehab.rehab_mid,
    rehab_estimate_high: rehab.rehab_high,
    confidence: rehab.confidence,
    line_items,
    red_flags: rehab.red_flags,
    photo_count: photos.length,
    photo_sources,
    market_multiplier: rehab.market_multiplier,
    analyzed_at: rehab.computed_at,
  };

  // Field-name fix 2026-06-04 (silent-422 sweep): this PATCH had been
  // failing entirely on every fire because 8 of the 9 fields below
  // didn't exist in the Listings_V1 schema (Airtable PATCH is atomic,
  // so ANY unknown field 422s the whole write). Renames to the
  // canonical Rehab_* names; removed Visual_Verified + Visual_Source
  // (no schema analog — flagged for operator: schema add or accept
  // that this route no longer tracks "visually verified" provenance).
  try {
    await updateListingRecord(recordId, {
      Rehab_Est_Low: rehab.rehab_low,
      Est_Rehab_Mid: rehab.rehab_mid,
      Rehab_Est_High: rehab.rehab_high,
      Rehab_Confidence_Score: rehab.confidence,
      Rehab_Line_Items_JSON: JSON.stringify(result.line_items),
      Rehab_Red_Flags: rehab.red_flags.join(", ") || "",
      Rehab_Estimated_At: result.analyzed_at,
      // Visual_Verified + Visual_Source: REMOVED — no schema analog.
      // The downstream pre-offer-screen guard reads listing.visualVerified
      // which is also broken (stale-read mapping). Operator decision
      // pending — see audit report 2026-06-04 (Spine recd9RNKGWOWjjDzz).
      // Rehab_Source: write a fixed "vision" — this route only runs
      // the automated vision pipeline. visualSource ("Both"/"Listing
      // Photos"/"Street View") is not a valid Rehab_Source enum value
      // and was 422ing too.
      Rehab_Source: "vision",
    });
  } catch (err) {
    console.error(`[photo-analysis] Failed to persist for ${recordId}:`, err);
  }

  await audit({
    agent: "phase4b-wrapper",
    event: "photo_analyzed",
    status: "confirmed_success",
    recordId,
    inputSummary: {
      address: listing.address,
      zip: listing.zip,
      sqft: listing.buildingSqFt,
      photo_count: photos.length,
    },
    outputSummary: {
      condition_overall: rehab.condition_overall,
      rehab_mid: rehab.rehab_mid,
      market_multiplier: rehab.market_multiplier,
      confidence: rehab.confidence,
      red_flags: rehab.red_flags,
    },
    decision: rehab.condition_overall,
    ms: Date.now() - t0,
  });

  cache[recordId] = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}
