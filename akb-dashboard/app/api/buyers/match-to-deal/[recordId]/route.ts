import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { listBuyersV2, BUYER_V2_FIELDS } from "@/lib/buyers-v2";
import type { BuyerMatchResult, BuyerMatch } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE_TTL_MS = 60 * 60_000;
const cache: Record<string, { data: BuyerMatchResult; ts: number }> = {};

// Coarse Detroit ZIP cluster — 482xx are urban Detroit, 481xx is suburban
// Wayne/Oakland/Macomb. We treat anything in 481xx/482xx as adjacent to a
// 482xx target.
function zipsAdjacent(targetZip: string, candidateZip: string): boolean {
  if (!targetZip || !candidateZip) return false;
  const t = targetZip.slice(0, 3);
  const c = candidateZip.slice(0, 3);
  if (t === c) return true;
  if ((t === "482" && c === "481") || (t === "481" && c === "482")) return true;
  return false;
}

interface ListingForMatch {
  zip: string;
  state: string;
  city: string;
  listPrice: number | null;
  yourMao: number | null;
  estRehabMid: number | null;
  bedrooms: number | null;
  condition: "Good" | "Fair" | "Average" | "Poor" | "Disrepair" | null;
}

function inferCondition(redFlags: string[] | string | null): ListingForMatch["condition"] {
  if (!redFlags) return null;
  const arr = Array.isArray(redFlags) ? redFlags : redFlags.split(",").map((s) => s.trim()).filter(Boolean);
  if (arr.some((f) => ["fire_damage_visible", "structural_compromise", "demolition_required"].includes(f))) return "Disrepair";
  if (arr.some((f) => ["foundation_settling", "no_roof_visible"].includes(f))) return "Poor";
  if (arr.length > 0) return "Fair";
  return "Average";
}

function expectedBuyerType(condition: ListingForMatch["condition"]): "flipper" | "landlord" | null {
  if (condition === "Disrepair" || condition === "Poor") return "flipper";
  if (condition === "Average" || condition === "Fair") return "landlord";
  return null;
}

export async function POST(
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

  const target: ListingForMatch = {
    zip: listing.zip ?? "",
    state: (listing.state ?? "").toUpperCase(),
    city: listing.city ?? "",
    listPrice: listing.listPrice,
    yourMao: listing.yourMao ?? null,
    estRehabMid: listing.estRehabMid ?? null,
    bedrooms: listing.bedrooms,
    condition: inferCondition(listing.redFlags ?? null),
  };

  // Acquisition target = your_mao if available, else 65% of list.
  const acqTarget = target.yourMao ?? (target.listPrice ? Math.round(target.listPrice * 0.65) : null);

  // Filter buyers: not Dead, market or state contains the deal's market.
  // We pull all Cold/Warmed/Active buyers — the table is small (low thousands).
  const formula = `NOT(OR({${BUYER_V2_FIELDS.Status}}="Dead", {${BUYER_V2_FIELDS.Status}}=""))`;
  const buyers = await listBuyersV2({ filterByFormula: formula, maxRecords: 5000 });

  const expected = expectedBuyerType(target.condition);

  const scored: BuyerMatch[] = buyers
    .map((buyer) => {
      const reasoning: string[] = [];
      let score = 0;

      // Markets / state match
      const buyerMarkets = (buyer.markets ?? []).map((m) => m.toLowerCase());
      const stateMatch = buyerMarkets.some((m) =>
        (target.state === "MI" && m === "detroit") ||
        (target.state === "TX" && (m === "san antonio" || m === "dallas" || m === "houston")) ||
        (target.state === "TN" && m === "memphis") ||
        (target.state === "GA" && m === "atlanta"),
      );
      if (!stateMatch && buyerMarkets.length > 0 && !buyerMarkets.includes("other")) {
        // Hard filter: buyer doesn't list this state at all
        return null;
      }

      // Same ZIP / adjacent
      const buyerZips = (buyer.targetZips ?? "").split(",").map((z) => z.trim()).filter(Boolean);
      if (buyerZips.includes(target.zip)) {
        score += 50;
        reasoning.push(`Same ZIP (${target.zip}) in target list`);
      } else if (buyerZips.some((z) => zipsAdjacent(target.zip, z))) {
        score += 30;
        reasoning.push(`Adjacent ZIP cluster`);
      }

      // Property type
      const propTypes = buyer.propertyTypePreference ?? [];
      if (propTypes.includes("Single Family")) {
        score += 20;
        reasoning.push("SFR preference matches");
      }

      // Buyer type alignment
      if (expected && buyer.buyerType === expected) {
        score += 15;
        reasoning.push(`${expected} buyer for ${target.condition} property`);
      }

      // Recency
      if (buyer.lastPurchaseDate) {
        const days = Math.floor((Date.now() - new Date(buyer.lastPurchaseDate).getTime()) / 86_400_000);
        if (!isNaN(days) && days < 90) {
          score += 25;
          reasoning.push(`Recent purchase ${days}d ago`);
        }
      }

      // Volume tier
      if (buyer.linkedDealCount != null) {
        if (buyer.linkedDealCount > 100) {
          score += 30;
          reasoning.push(`High volume (${buyer.linkedDealCount} deals)`);
        } else if (buyer.linkedDealCount > 50) {
          score += 20;
          reasoning.push(`Volume (${buyer.linkedDealCount} deals)`);
        }
      }

      // Price band
      if (acqTarget != null) {
        if (buyer.minPrice != null && Math.abs(buyer.minPrice - acqTarget) <= 5_000) {
          score += 20;
          reasoning.push(`Min price within $5K of acquisition target`);
        }
        if (buyer.maxPrice != null && acqTarget > buyer.maxPrice * 1.1) {
          // Price way outside their band — soft penalty
          score -= 30;
          reasoning.push(`Acquisition target above buyer max`);
        }
      }

      return { buyer, score, reasoning };
    })
    .filter((m): m is BuyerMatch => Boolean(m))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);

  const result: BuyerMatchResult = {
    recordId,
    matches: scored,
    generated_at: new Date().toISOString(),
  };
  cache[recordId] = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}
