import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { collectPhotos } from "@/lib/photo-sources";
import type {
  PhotoAnalysisResult,
  PhotoLineItem,
  PhotoRedFlag,
  PropertyCondition,
} from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 60;

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const CACHE_TTL_MS = 24 * 60 * 60_000;
const cache: Record<string, { data: PhotoAnalysisResult; ts: number }> = {};

const ZIP_MULTIPLIERS: Array<{ prefix: string; mult: number }> = [
  { prefix: "48", mult: 0.85 }, // Detroit area
  { prefix: "78", mult: 1.0 },  // San Antonio
  { prefix: "38", mult: 0.9 },  // Memphis
  { prefix: "75", mult: 1.05 }, // Dallas
];

function marketMultiplierForZip(zip: string | null | undefined): number {
  if (!zip) return 1.0;
  const z = zip.trim();
  for (const { prefix, mult } of ZIP_MULTIPLIERS) {
    if (z.startsWith(prefix)) return mult;
  }
  return 1.0;
}

const VALID_CONDITIONS: PropertyCondition[] = ["Good", "Fair", "Average", "Poor", "Disrepair"];
const VALID_RED_FLAGS: PhotoRedFlag[] = [
  "fire_damage_visible", "structural_compromise", "no_roof_visible",
  "demolition_required", "foundation_settling", "water_damage",
  "broken_windows", "signs_of_squatting", "overgrown_lot",
  "utilities_disconnected", "debris_present",
];

function safeNum(v: unknown, fallback = 0): number {
  return typeof v === "number" && !isNaN(v) ? v : fallback;
}

function parseAnalysis(raw: string): {
  condition_overall: PropertyCondition;
  rehab_estimate_low: number;
  rehab_estimate_high: number;
  rehab_estimate_mid: number;
  confidence: number;
  line_items: PhotoLineItem[];
  red_flags: PhotoRedFlag[];
} {
  let parsed: Record<string, unknown> = {};
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // Fallback to a maximally cautious analysis
    return {
      condition_overall: "Poor",
      rehab_estimate_low: 0,
      rehab_estimate_high: 0,
      rehab_estimate_mid: 0,
      confidence: 0,
      line_items: [],
      red_flags: [],
    };
  }

  const cond = String(parsed.condition_overall ?? "Poor");
  const condition_overall: PropertyCondition = (VALID_CONDITIONS as string[]).includes(cond)
    ? (cond as PropertyCondition)
    : "Poor";

  const lo = safeNum(parsed.rehab_estimate_low);
  const hi = safeNum(parsed.rehab_estimate_high);
  const mid = safeNum(parsed.rehab_estimate_mid, Math.round((lo + hi) / 2));

  const lineItemsRaw = Array.isArray(parsed.line_items) ? (parsed.line_items as Array<Record<string, unknown>>) : [];
  const line_items: PhotoLineItem[] = lineItemsRaw.map((li) => ({
    category: String(li.category ?? "other") as PhotoLineItem["category"],
    estimate_low: safeNum(li.estimate_low),
    estimate_high: safeNum(li.estimate_high),
    confidence: ((): "HIGH" | "MED" | "LOW" => {
      const c = String(li.confidence ?? "").toUpperCase();
      return c === "HIGH" || c === "MED" || c === "LOW" ? c : "LOW";
    })(),
    notes: String(li.notes ?? ""),
  }));

  const flagsRaw = Array.isArray(parsed.red_flags) ? (parsed.red_flags as unknown[]) : [];
  const red_flags: PhotoRedFlag[] = flagsRaw
    .map((f) => String(f))
    .filter((f): f is PhotoRedFlag => (VALID_RED_FLAGS as string[]).includes(f));

  return {
    condition_overall,
    rehab_estimate_low: lo,
    rehab_estimate_high: hi,
    rehab_estimate_mid: mid,
    confidence: Math.max(0, Math.min(100, safeNum(parsed.confidence))),
    line_items,
    red_flags,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
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
    .filter(Boolean).join(", ");
  const photos = await collectPhotos({
    verificationUrl: listing.verificationUrl,
    fullAddress,
  });

  if (photos.length === 0) {
    return NextResponse.json(
      {
        error: "No photos available for analysis",
        detail: "Both listing-photo scrape (ScraperAPI) and Street View collection returned 0 photos. Check SCRAPER_API_KEY, GOOGLE_MAPS_API_KEY, and Verification_URL.",
        recordId,
      },
      { status: 422 },
    );
  }

  const userContent: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "url"; url: string } }> = [
    {
      type: "text",
      text: `Analyze these property photos for AKB Solutions wholesale due diligence.

Address: ${fullAddress}
SqFt: ${listing.buildingSqFt ?? "unknown"}
Bed/Bath: ${listing.bedrooms ?? "?"} / ${listing.bathrooms ?? "?"}

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "condition_overall": "Good" | "Fair" | "Average" | "Poor" | "Disrepair",
  "rehab_estimate_low": <number>,
  "rehab_estimate_mid": <number>,
  "rehab_estimate_high": <number>,
  "confidence": <0-100>,
  "line_items": [
    {
      "category": "roof"|"exterior"|"interior"|"kitchen"|"bathroom"|"hvac"|"electrical"|"plumbing"|"foundation"|"other",
      "estimate_low": <number>,
      "estimate_high": <number>,
      "confidence": "HIGH"|"MED"|"LOW",
      "notes": "<short>"
    }
  ],
  "red_flags": ["fire_damage_visible"|"structural_compromise"|"no_roof_visible"|"demolition_required"|"foundation_settling"|"water_damage"|"broken_windows"|"signs_of_squatting"|"overgrown_lot"|"utilities_disconnected"|"debris_present"]
}

Be aggressive about red_flags — false positives are recoverable, missed fire/structural damage is not. Estimates are rehab cost in USD before any market multiplier.`,
    },
    ...photos.map((p) => ({ type: "image" as const, source: { type: "url" as const, url: p.url } })),
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2048,
      system:
        "You are a property condition analyst for a wholesale real estate firm. Output STRICT JSON only — no markdown, no commentary.",
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`[photo-analysis] Anthropic ${res.status}:`, errText);
    return NextResponse.json(
      { error: `Anthropic vision ${res.status}`, detail: errText, recordId },
      { status: 502 },
    );
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";
  const parsed = parseAnalysis(text);

  // Apply market multiplier on rehab estimates.
  const mult = marketMultiplierForZip(listing.zip);
  const rehab_low = Math.round(parsed.rehab_estimate_low * mult);
  const rehab_mid = Math.round(parsed.rehab_estimate_mid * mult);
  const rehab_high = Math.round(parsed.rehab_estimate_high * mult);

  const photo_sources = Array.from(new Set(photos.map((p) => p.source))) as Array<"listing" | "streetview">;
  const visualSource =
    photo_sources.length === 2
      ? "Both"
      : photo_sources[0] === "listing"
        ? "Listing Photos"
        : "Street View";

  const result: PhotoAnalysisResult = {
    recordId,
    condition_overall: parsed.condition_overall,
    rehab_estimate_low: rehab_low,
    rehab_estimate_mid: rehab_mid,
    rehab_estimate_high: rehab_high,
    confidence: parsed.confidence,
    line_items: parsed.line_items.map((li) => ({
      ...li,
      estimate_low: Math.round(li.estimate_low * mult),
      estimate_high: Math.round(li.estimate_high * mult),
    })),
    red_flags: parsed.red_flags,
    photo_count: photos.length,
    photo_sources,
    market_multiplier: mult,
    analyzed_at: new Date().toISOString(),
  };

  // Persist to Airtable. typecast=true so new columns/options auto-create.
  try {
    await updateListingRecord(recordId, {
      Est_Rehab_Low: rehab_low,
      Est_Rehab_Mid: rehab_mid,
      Est_Rehab_High: rehab_high,
      Photo_Confidence: parsed.confidence,
      Line_Items_JSON: JSON.stringify(result.line_items),
      Red_Flags: parsed.red_flags.join(", ") || "",
      Photo_Analyzed_At: result.analyzed_at,
      Visual_Verified: true,
      Visual_Source: visualSource,
    });
  } catch (err) {
    console.error(`[photo-analysis] Failed to persist for ${recordId}:`, err);
  }

  cache[recordId] = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}
