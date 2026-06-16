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
import type { Deal } from "@/lib/types";
import type { PreEmdGateInput } from "./pre-emd-gate";

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

  let buyerMedian: number | null = null;
  try {
    if (listing) {
      const pi = await findPropertyIntelRecordByListing(listing.id);
      const bm = pi?.fields?.["Buyer_Median_Value"];
      buyerMedian = typeof bm === "number" ? bm : null;
    }
  } catch {
    buyerMedian = null;
  }

  const st = (listing?.state ?? "").trim().toUpperCase();

  return {
    recordId: listing?.id ?? deal.id,
    // DD-1: a real validated ARV requires the operator's comps-validation
    // attestations (Pre_EMD_ARV_Confirmed AND Pre_EMD_CMA_Validated) — a bare
    // stored/AVM ARV does not count.
    arvValue: listing?.realArvMedian ?? null,
    arvValidatedFromComps: deal.preEmdArvConfirmed === true && deal.preEmdCmaValidated === true,
    arvValidatedAt: listing?.arvValidatedAt ?? null,
    arvCompCount: listing?.arvCompCount ?? null,
    // DD-2:
    estRehab: listing?.estRehab ?? listing?.estRehabMid ?? null,
    estRehabHigh: listing?.estRehabHigh ?? null,
    rehabConfidence: scoreToConfidence(listing?.rehabConfidenceScore),
    rehabEstimatedAt: listing?.rehabEstimatedAt ?? null,
    // DD-3:
    buyerMedian,
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
