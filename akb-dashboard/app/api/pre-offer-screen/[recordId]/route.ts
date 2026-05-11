import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import type {
  ArvValidationResult,
  PhotoAnalysisResult,
  PreOfferCheck,
  PreOfferScreenResult,
} from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 60;

const HARD_BLOCKING_FLAGS = new Set(["fire_damage_visible", "structural_compromise", "foundation_settling"]);
const HIGH_OFFER_FLAGS = new Set(["no_roof_visible", "demolition_required"]);
const WARN_FLAGS = new Set(["water_damage", "signs_of_squatting"]);

const DISTRESS_KEYWORDS = ["fire", "as-is", "no warranty", "cash only", "estate sale", "court ordered"];
const RESTRICTION_KEYWORDS = ["accepting backups", "kick-out clause", "kick out clause"];

function originFromReq(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

async function fetchPhotoAnalysis(origin: string, recordId: string, cookie: string | null): Promise<PhotoAnalysisResult | null> {
  try {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${origin}/api/photo-analysis/${recordId}`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as PhotoAnalysisResult;
  } catch {
    return null;
  }
}

async function fetchArvValidation(origin: string, recordId: string, cookie: string | null): Promise<ArvValidationResult | null> {
  try {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${origin}/api/arv-validate/${recordId}`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ArvValidationResult;
  } catch {
    return null;
  }
}

function check(severity: PreOfferCheck["severity"], name: string, reason: string, suggestedAction?: string): PreOfferCheck {
  return { check: name, severity, reason, suggestedAction };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const { recordId } = await params;
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", recordId }, { status: 400 });
  }

  let body: { proposedOfferAmount?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const proposedOfferAmount = typeof body.proposedOfferAmount === "number" ? body.proposedOfferAmount : null;

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found", recordId }, { status: 404 });
  }

  const origin = originFromReq(req);
  const cookie = req.headers.get("cookie");

  // Run photo + ARV in parallel — both endpoints have their own caches.
  const [photo, arv] = await Promise.all([
    fetchPhotoAnalysis(origin, recordId, cookie),
    fetchArvValidation(origin, recordId, cookie),
  ]);

  const checks: PreOfferCheck[] = [];

  // CHECK 1 — Visual verification
  if (!photo) {
    checks.push(check("WARN", "visual_verification", "Photo analysis unavailable. Cannot visually verify property condition."));
  } else {
    const flags = new Set(photo.red_flags);
    const hardFlag = Array.from(flags).find((f) => HARD_BLOCKING_FLAGS.has(f));
    if (hardFlag) {
      checks.push(check("BLOCK", "visual_verification", `Red flag detected: ${hardFlag}.`, "Walk this listing — visual evidence shows un-recoverable damage."));
    }
    const highOfferFlag = Array.from(flags).find((f) => HIGH_OFFER_FLAGS.has(f));
    if (highOfferFlag && (listing.listPrice ?? 0) < 30_000) {
      checks.push(check("BLOCK", "visual_verification", `${highOfferFlag} on a sub-$30K list — too risky.`));
    }
    for (const f of flags) {
      if (WARN_FLAGS.has(f)) {
        checks.push(check("WARN", "visual_verification", `Visual concern: ${f}.`));
      }
    }
    if (photo.confidence < 60) {
      checks.push(check("WARN", "visual_verification", `Photo confidence is ${photo.confidence}/100 — manual review recommended.`));
    }
  }

  // CHECK 2 — Listing history (best-effort; full price-history requires
  // separate scrape pipeline). We use Restriction_Text + Notes tokens.
  const restriction = (listing.restrictionText ?? "").toLowerCase();
  if (RESTRICTION_KEYWORDS.some((k) => restriction.includes(k))) {
    checks.push(check("WARN", "listing_history", "Restriction text mentions backups / kick-out clause."));
  }

  // CHECK 3 — ARV validation
  if (!arv) {
    checks.push(check("WARN", "arv_validation", "ARV validation unavailable."));
  } else {
    if (proposedOfferAmount != null && arv.your_mao != null && arv.your_mao < proposedOfferAmount) {
      checks.push(check("BLOCK", "arv_validation", `Your MAO ($${arv.your_mao.toLocaleString()}) is below proposed offer ($${proposedOfferAmount.toLocaleString()}). Negative spread.`));
    }
    if (arv.your_mao != null && listing.listPrice && arv.your_mao < listing.listPrice * 0.5) {
      checks.push(check("BLOCK", "arv_validation", `Your MAO < 50% of list. Math impossible.`));
    }
    if (proposedOfferAmount != null && arv.your_mao != null && arv.your_mao - proposedOfferAmount < 5_000) {
      checks.push(check("WARN", "arv_validation", `Spread under $5K — below fee floor.`));
    }
    if (arv.spread_label === "negative") {
      checks.push(check("BLOCK", "arv_validation", `ARV spread is negative.`));
    } else if (arv.spread_label === "tight") {
      checks.push(check("WARN", "arv_validation", `ARV spread is tight (${arv.your_mao_pct != null ? Math.round(arv.your_mao_pct * 100) : "?"}%).`));
    }
  }

  // CHECK 4 — Distress signal mismatch
  const desc = (listing.notes ?? "").toLowerCase();
  const hasDistress = DISTRESS_KEYWORDS.some((k) => desc.includes(k));
  if (hasDistress && photo && (photo.condition_overall === "Good" || photo.condition_overall === "Fair")) {
    checks.push(check("BLOCK", "distress_mismatch", `Listing says distressed (${DISTRESS_KEYWORDS.find((k) => desc.includes(k))}) but photos show ${photo.condition_overall}. Data conflict.`));
  }

  // CHECK 5 — DOM trend
  if (listing.dom != null && listing.dom > 365) {
    checks.push(check("WARN", "dom_trend", `On market ${listing.dom}d. Pricing likely sticky.`));
  }
  if (listing.dom != null && listing.dom < 7 && photo && photo.confidence < 70) {
    checks.push(check("WARN", "dom_trend", `Fresh listing (DOM ${listing.dom}) + low photo confidence — risk of stale data.`));
  }

  // CHECK 6 — DD progression: high offer requires visual verification
  const isHighOffer = proposedOfferAmount != null && listing.listPrice && proposedOfferAmount > listing.listPrice * 0.85;
  if (isHighOffer && !listing.visualVerified) {
    checks.push(check("BLOCK", "dd_progression", "High offer (>85% of list) requires Visual_Verified=true."));
  }

  const blockers = checks.filter((c) => c.severity === "BLOCK");
  const warnings = checks.filter((c) => c.severity === "WARN");
  const passed = blockers.length === 0;

  const screened_at = new Date().toISOString();
  const result: PreOfferScreenResult = {
    recordId,
    proposedOfferAmount,
    passed,
    blockers,
    warnings,
    checks,
    screened_at,
  };

  // Persist to Airtable.
  try {
    await updateListingRecord(recordId, {
      Pre_Offer_Screen_Result: passed ? (warnings.length > 0 ? "Warn" : "Pass") : "Block",
      Pre_Offer_Screen_Notes: [
        ...blockers.map((b) => `BLOCK: ${b.check} — ${b.reason}`),
        ...warnings.map((w) => `WARN: ${w.check} — ${w.reason}`),
      ].join("\n"),
      Pre_Offer_Screen_At: screened_at,
    });
  } catch (err) {
    console.error(`[pre-offer-screen] Failed to persist for ${recordId}:`, err);
  }

  return NextResponse.json(result);
}
