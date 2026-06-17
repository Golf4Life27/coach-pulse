// INV-023 Pre-EMD gate — LIVE input assembler (Milestone 2, deliverable B).
//
// Maps a live Deal + its joined Listing + Property_Intel onto the pure
// PreEmdGateInput, so the EMD-advance action (app/api/deals/request-emd) can
// call evaluatePreEmdGate() at runtime. FAIL-CLOSED by construction: any
// fetch failure or missing field maps to the BLOCKING interpretation (the
// gate then BLOCKS on absence — the cardinal property), never to a pass.

import { getListings } from "@/lib/airtable";
import { findPropertyIntelRecordByListing } from "@/lib/federation/property-intel-store";
import { normalizeAddressKey } from "@/lib/crawler/intake-filter";
import { getZipArvSeed } from "@/lib/zip-arv-seed-store";
import { getZipBuyerMedian } from "@/lib/buyer-median-store";
import { defaultBuyerTrack } from "@/lib/buyer-median-input";
import { evaluateArvFromSeed, isArvEngineAutocompleteLive } from "./arv-comp-engine";
import { isBuyerMedianLive, BUYER_MEDIAN_MIN_N } from "@/lib/buyer-intel/buyer-median";
import { evaluatePreEmdGate, type PreEmdGateInput, type PreEmdGateResult } from "./pre-emd-gate";
import type { Deal } from "@/lib/types";

/** Map the numeric Rehab_Confidence_Score to the gate's confidence band.
 *  Anything not clearly HIGH is treated as low-confidence → pessimistic. */
function scoreToConfidence(score: number | null | undefined): "HIGH" | "MED" | "LOW" {
  if (typeof score === "number" && score >= 70) return "HIGH";
  if (typeof score === "number" && score >= 40) return "MED";
  return "LOW";
}

/**
 * Assemble the gate input for a Deal. Joins the Listing by normalized street
 * address (the reverse of the pre-emd-evaluate join) and reads Buyer_Median
 * from Property_Intel. Every catch maps to null → the gate BLOCKS.
 */
export async function assemblePreEmdGateInputForDeal(deal: Deal): Promise<PreEmdGateInput> {
  let listing: Awaited<ReturnType<typeof getListings>>[number] | null = null;
  try {
    if (deal.propertyAddress) {
      const wantKey = normalizeAddressKey(deal.propertyAddress.split(",")[0]);
      if (wantKey) {
        const listings = await getListings();
        listing =
          listings.find((l) => l.address && normalizeAddressKey(l.address.split(",")[0]) === wantKey) ?? null;
      }
    }
  } catch {
    listing = null;
  }

  // DD-3 buyer ceiling. LIVE (BUYER_MEDIAN_LIVE, M5): read the track-aware
  // Buyer_Median_ZIP store (computed from InvestorBase acquisitions) with the
  // min-n gate — n<20 → INSUFFICIENT → DD-3 BLOCKED → Manual Review.
  // WATCHED (default): fall back to the existing Property_Intel value.
  // Fail-closed: a live read error → INSUFFICIENT, never a fabricated number.
  let buyerMedian: number | null = null;
  let buyerMedianStatus: "OK" | "INSUFFICIENT" | null = null;
  let buyerMedianN: number | null = null;
  try {
    if (isBuyerMedianLive() && listing?.zip) {
      const track = defaultBuyerTrack({ distressed: typeof listing.distressScore === "number" && listing.distressScore > 0 });
      const zm = await getZipBuyerMedian(listing.zip, track);
      if (zm && zm.value > 0 && (zm.compCount ?? 0) >= BUYER_MEDIAN_MIN_N) {
        buyerMedian = zm.value;
        buyerMedianStatus = "OK";
        buyerMedianN = zm.compCount;
      } else {
        buyerMedianStatus = "INSUFFICIENT"; // no row / thin → fail-closed
        buyerMedianN = zm?.compCount ?? 0;
      }
    } else if (listing) {
      const pi = await findPropertyIntelRecordByListing(listing.id);
      const bm = pi?.fields?.["Buyer_Median_Value"];
      buyerMedian = typeof bm === "number" ? bm : null;
    }
  } catch {
    buyerMedian = null;
    buyerMedianStatus = isBuyerMedianLive() ? "INSUFFICIENT" : null;
  }

  const st = (listing?.state ?? "").trim().toUpperCase();

  // DD-1: the ARV Comp Engine validates ARV from the ZIP's renovated seed —
  // no operator tick, never a RentCast AVM, never the contaminated stored
  // field. DEFAULT-OFF (watched mode): the engine result is NOT used to
  // auto-tick in production until ARV_ENGINE_AUTOCOMPLETE_LIVE=true, so DD-1
  // stays BLOCKED while the operator reviews the watched run. Fail-closed.
  let arvEngine: PreEmdGateInput["arvEngine"] = null;
  try {
    if (isArvEngineAutocompleteLive() && listing?.zip) {
      const seed = await getZipArvSeed(listing.zip);
      arvEngine = evaluateArvFromSeed(
        { recordId: listing.id, zip: listing.zip, sqft: listing.buildingSqFt ?? null, propertyType: listing.propertyType ?? null },
        seed,
      );
    }
  } catch {
    arvEngine = null; // fail-closed — engine error → DD-1 BLOCKED, never a pass
  }

  return {
    recordId: listing?.id ?? deal.id,
    arvEngine,
    // DD-2:
    estRehab: listing?.estRehab ?? listing?.estRehabMid ?? null,
    estRehabHigh: listing?.estRehabHigh ?? null,
    rehabConfidence: scoreToConfidence(listing?.rehabConfidenceScore),
    rehabEstimatedAt: listing?.rehabEstimatedAt ?? null,
    // DD-3:
    buyerMedian,
    buyerMedianStatus,
    buyerMedianN,
    // DD-4:
    contractPrice: deal.contractPrice ?? null,
    // DD-5 / DD-6 / DD-9: deal-level operator attestations.
    assignmentClauseVerified: deal.preEmdAssignmentClauseVerified === true,
    photosValidated: deal.preEmdPhotosValidated === true,
    operatorSignoff: deal.preEmdOperatorSignoff === true,
    // DD-7: verify-before-act (Listing liveness).
    liveStatus: listing?.liveStatus ?? null,
    availabilityConfirmedAt: listing?.lastVerified ?? null,
    // DD-8: restricted-state / pause. TN → Memphis (the only TN market) is
    // paused; an explicit exception is out of band (defaults to not-approved).
    state: listing?.state ?? null,
    marketPaused: st === "TN",
    pauseExceptionApproved: false,
  };
}

/**
 * THE SINGLE ENFORCED GATE PATH (Milestone 4). Assemble + evaluate the INV-023
 * gate for one Deal. Every door that can advance a deal toward EMD / contract
 * signing calls this — the EMD-fire action (request-emd) AND the contract-sign
 * action (actions/sign_contract) — and the dashboard panel surfaces the SAME
 * result, so the displayed verdict and the enforced block can never diverge.
 * Fail-closed: assembly maps any missing data to a BLOCKING input.
 */
export async function runPreEmdGateForDeal(deal: Deal): Promise<PreEmdGateResult> {
  return evaluatePreEmdGate(await assemblePreEmdGateInputForDeal(deal));
}
