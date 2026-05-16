// Phase 4B — Rehab Calibration.
//
// Wraps the Anthropic Vision API to score property photos against the
// 4-tier × per-market-multiplier model in Bible v3 §4.2. Stateless, no
// Airtable I/O. Inputs: photo URLs + sqft + ZIP. Outputs: condition,
// rehab band, per-category line items, red flags, market multiplier.

import { rehabRates, marketMultiplierForZip } from "./config";

export type RehabCondition = "Good" | "Average" | "Fair" | "Poor" | "Disrepair";
export type RehabLineConfidence = "HIGH" | "MED" | "LOW";

export type RehabCategoryName =
  | "Exterior"
  | "Roof"
  | "Paint"
  | "Flooring"
  | "Kitchen"
  | "Bathrooms"
  | "HVAC"
  | "Electrical";

export const REHAB_CATEGORIES: RehabCategoryName[] = [
  "Exterior",
  "Roof",
  "Paint",
  "Flooring",
  "Kitchen",
  "Bathrooms",
  "HVAC",
  "Electrical",
];

export type RehabRedFlag =
  | "fire_damage_visible"
  | "structural_compromise"
  | "no_roof_visible"
  | "demolition_required"
  | "foundation_settling"
  | "water_damage"
  | "broken_windows"
  | "signs_of_squatting"
  | "overgrown_lot"
  | "utilities_disconnected"
  | "debris_present";

const VALID_RED_FLAGS: RehabRedFlag[] = [
  "fire_damage_visible",
  "structural_compromise",
  "no_roof_visible",
  "demolition_required",
  "foundation_settling",
  "water_damage",
  "broken_windows",
  "signs_of_squatting",
  "overgrown_lot",
  "utilities_disconnected",
  "debris_present",
];

const VALID_CONDITIONS: RehabCondition[] = ["Good", "Average", "Fair", "Poor", "Disrepair"];

export interface RehabLineItem {
  category: RehabCategoryName;
  estimate_low: number;
  estimate_high: number;
  confidence: RehabLineConfidence;
  notes: string;
}

export interface RehabCalibrationInput {
  photos_urls: string[];
  sqft: number | null;
  zip: string;
  address?: string;
  beds?: number | null;
  baths?: number | null;
  year_built?: number | null;
}

export interface RehabCalibrationResult {
  // Subject echo
  zip: string;
  market: string;
  market_multiplier: number;
  // Headline
  condition_overall: RehabCondition;
  rehab_low: number;
  rehab_mid: number;
  rehab_high: number;
  confidence: number;
  // Transparency
  line_items: RehabLineItem[];
  red_flags: RehabRedFlag[];
  photo_count: number;
  anchor_rate_per_sqft: number;
  vision_model: string;
  methodology_notes: string[];
  computed_at: string;
}

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VISION_MAX_TOKENS = 2048;

function safeNum(v: unknown, fallback = 0): number {
  return typeof v === "number" && !isNaN(v) ? v : fallback;
}

function parseVisionJson(raw: string): {
  condition_overall: RehabCondition;
  total_low: number;
  total_high: number;
  total_mid: number;
  confidence: number;
  line_items: RehabLineItem[];
  red_flags: RehabRedFlag[];
} {
  let parsed: Record<string, unknown> = {};
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return {
      condition_overall: "Poor",
      total_low: 0,
      total_high: 0,
      total_mid: 0,
      confidence: 0,
      line_items: [],
      red_flags: [],
    };
  }

  const condRaw = String(parsed.condition_overall ?? "Poor");
  const condition_overall: RehabCondition = (VALID_CONDITIONS as string[]).includes(condRaw)
    ? (condRaw as RehabCondition)
    : "Poor";

  const itemsRaw = Array.isArray(parsed.line_items)
    ? (parsed.line_items as Array<Record<string, unknown>>)
    : Array.isArray(parsed.categories)
      ? (parsed.categories as Array<Record<string, unknown>>)
      : [];

  const line_items: RehabLineItem[] = itemsRaw
    .map((li): RehabLineItem | null => {
      const name = String(li.category ?? li.name ?? "");
      if (!(REHAB_CATEGORIES as string[]).includes(name)) return null;
      return {
        category: name as RehabCategoryName,
        estimate_low: safeNum(li.estimate_low ?? li.low),
        estimate_high: safeNum(li.estimate_high ?? li.high),
        confidence: ((): RehabLineConfidence => {
          const c = String(li.confidence ?? "").toUpperCase();
          return c === "HIGH" || c === "MED" || c === "MEDIUM" || c === "LOW"
            ? (c === "MEDIUM" ? "MED" : (c as RehabLineConfidence))
            : "LOW";
        })(),
        notes: String(li.notes ?? ""),
      };
    })
    .filter((x): x is RehabLineItem => x !== null);

  const flagsRaw = Array.isArray(parsed.red_flags) ? (parsed.red_flags as unknown[]) : [];
  const red_flags: RehabRedFlag[] = flagsRaw
    .map((f) => String(f))
    .filter((f): f is RehabRedFlag => (VALID_RED_FLAGS as string[]).includes(f));

  const lo = safeNum(parsed.total_low ?? parsed.rehab_estimate_low);
  const hi = safeNum(parsed.total_high ?? parsed.rehab_estimate_high);
  const mid = safeNum(
    parsed.total_mid ?? parsed.rehab_estimate_mid,
    Math.round((lo + hi) / 2),
  );
  const confidence = Math.max(
    0,
    Math.min(100, safeNum(parsed.overall_confidence_score ?? parsed.confidence)),
  );

  return { condition_overall, total_low: lo, total_high: hi, total_mid: mid, confidence, line_items, red_flags };
}

function buildVisionPrompt(input: RehabCalibrationInput, market: string, mult: number): string {
  return `You are a real estate rehab cost estimator with 15 years of experience in TX and TN markets. Analyze the provided photos.

Subject:
  Address: ${input.address ?? "unknown"}
  ZIP: ${input.zip}
  Market: ${market} (cost multiplier ${mult.toFixed(2)})
  SqFt: ${input.sqft ?? "unknown"}
  Bed/Bath: ${input.beds ?? "?"} / ${input.baths ?? "?"}
  Year Built: ${input.year_built ?? "unknown"}

Pricing anchors (per-sqft, BEFORE market multiplier — the API caller applies the multiplier):
  Good      $${rehabRates.rates_per_sqft.Good}/sqft   (lipstick: paint, fixtures, minor)
  Average   $${rehabRates.rates_per_sqft.Average}/sqft   (cosmetic + light mechanical)
  Fair      $${rehabRates.rates_per_sqft.Fair}/sqft   (major work: kitchen, bath, some systems)
  Poor      $${rehabRates.rates_per_sqft.Poor}/sqft   (full gut: kitchen, bath, systems, possibly structural)

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "condition_overall": "Good" | "Average" | "Fair" | "Poor" | "Disrepair",
  "total_low": <number USD, pre-multiplier>,
  "total_mid": <number USD, pre-multiplier>,
  "total_high": <number USD, pre-multiplier>,
  "overall_confidence_score": <0-100>,
  "line_items": [
    {
      "category": "Exterior"|"Roof"|"Paint"|"Flooring"|"Kitchen"|"Bathrooms"|"HVAC"|"Electrical",
      "estimate_low": <number>,
      "estimate_high": <number>,
      "confidence": "HIGH"|"MED"|"LOW",
      "notes": "<short>"
    }
  ],
  "red_flags": ["fire_damage_visible"|"structural_compromise"|"no_roof_visible"|"demolition_required"|"foundation_settling"|"water_damage"|"broken_windows"|"signs_of_squatting"|"overgrown_lot"|"utilities_disconnected"|"debris_present"]
}

Rules:
- Return all 8 categories. If a category is unaffected, use small numbers and confidence LOW.
- Be aggressive about red_flags — false positives are recoverable, missed fire/structural damage is not.
- Estimates are rehab cost in USD pre-multiplier. The caller multiplies by the market factor.`;
}

export async function callRehabVision(
  input: RehabCalibrationInput,
  apiKey: string,
): Promise<RehabCalibrationResult> {
  const notes: string[] = [];
  const { multiplier, market } = marketMultiplierForZip(input.zip);
  notes.push(`Market multiplier ${multiplier.toFixed(2)} (${market}) applied per rehab_rates.json v${rehabRates.version}.`);

  if (input.photos_urls.length === 0) {
    throw new Error("photos_urls empty — Phase 4B needs at least one image");
  }

  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "url"; url: string } }
  > = [
    { type: "text", text: buildVisionPrompt(input, market, multiplier) },
    ...input.photos_urls.slice(0, 10).map((url) => ({
      type: "image" as const,
      source: { type: "url" as const, url },
    })),
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
      max_tokens: ANTHROPIC_VISION_MAX_TOKENS,
      system:
        "You are a property condition analyst for a wholesale real estate firm. Output STRICT JSON only — no markdown, no commentary.",
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic vision ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";
  const parsed = parseVisionJson(text);

  // Apply market multiplier on totals and on each line item.
  const rehab_low = Math.round(parsed.total_low * multiplier);
  const rehab_mid = Math.round(parsed.total_mid * multiplier);
  const rehab_high = Math.round(parsed.total_high * multiplier);
  const line_items = parsed.line_items.map((li) => ({
    ...li,
    estimate_low: Math.round(li.estimate_low * multiplier),
    estimate_high: Math.round(li.estimate_high * multiplier),
  }));

  const anchor = rehabRates.rates_per_sqft[parsed.condition_overall] ?? 0;
  notes.push(
    `Vision returned condition=${parsed.condition_overall}; anchor rate $${anchor}/sqft pre-multiplier.`,
  );
  if (parsed.confidence < 60) {
    notes.push("Vision confidence <60 — recommend Hold and re-collect photos before outreach.");
  }
  if (parsed.red_flags.length > 0) {
    notes.push(`Red flags detected: ${parsed.red_flags.join(", ")}`);
  }

  return {
    zip: input.zip,
    market,
    market_multiplier: multiplier,
    condition_overall: parsed.condition_overall,
    rehab_low,
    rehab_mid,
    rehab_high,
    confidence: parsed.confidence,
    line_items,
    red_flags: parsed.red_flags,
    photo_count: input.photos_urls.length,
    anchor_rate_per_sqft: anchor,
    vision_model: ANTHROPIC_MODEL,
    methodology_notes: notes,
    computed_at: new Date().toISOString(),
  };
}
