// Phase 4D / L.1 — BroCard pricing classifier.
//
// Pure helper that maps a Listing's pricing fields into the BroCard
// pricing payload (phase4 | legacy | no_math). The mode gate is
// "did the math layer produce a usable floor?" — that drives whether
// the BroCard surfaces the full v1.3 range envelope or falls back to
// the legacy / no-math affordances.
//
// Lives outside the route + component so L.3 can drop pure-function
// unit tests without React/JSX (per the vitest "no React" rule).

import { computeMaoRange, pickCalibratedRehab } from "@/lib/appraiser/mao-range";
import type { Listing } from "@/lib/types";
import type {
  BroCardPricing,
  BroCardPricingPhase4,
} from "@/types/jarvis";

// The minimal Listing surface this classifier reads. Narrowed so the
// helper is reusable from callers that hold a partial listing object.
export type PricingClassifierListing = Pick<
  Listing,
  | "realArvMedian"
  | "estRehab"
  | "estRehabMid"
  | "wholesaleFeeTarget"
  | "buyerProfitTarget"
  | "listPrice"
  | "sellerMotivationScore"
  | "estimatedMonthlyRent"
  | "state"
  | "outreachOfferPrice"
  | "contractOfferPrice"
>;

/**
 * Classify a listing into the BroCard pricing payload. Pure.
 *
 *   phase4  — computeMaoRange returns a non-null floor (the math layer
 *             produced a V2.1-floor or landlord-track answer).
 *   legacy  — math layer can't produce a floor BUT the listing has
 *             outreach_offer_price OR contract_offer_price from the
 *             pre-Phase-4 single-track path.
 *   no_math — neither path has data.
 */
export function classifyBroCardPricing(
  listing: PricingClassifierListing,
): BroCardPricing {
  const rehabPick = pickCalibratedRehab({
    estRehabMid: listing.estRehabMid,
    estRehab: listing.estRehab,
  });

  const range = computeMaoRange({
    arvMid: listing.realArvMedian ?? null,
    estRehab: rehabPick.value,
    wholesaleFee: listing.wholesaleFeeTarget ?? null,
    buyerProfit: listing.buyerProfitTarget ?? null,
    listPrice: listing.listPrice ?? null,
    sellerMotivationScore: listing.sellerMotivationScore ?? null,
    monthlyRent: listing.estimatedMonthlyRent ?? null,
    state: listing.state ?? null,
  });

  if (range.floor != null) {
    const phase4: BroCardPricingPhase4 = {
      mode: "phase4",
      range: {
        floor: range.floor,
        target: range.target,
        list_price: range.list_price,
        soft_ceiling: range.soft_ceiling,
        exceeds_soft_ceiling: range.exceeds_soft_ceiling,
        dual_track: range.dual_track
          ? {
              flipper_mao: range.dual_track.flipper_mao,
              landlord_mao: range.dual_track.landlord_mao,
              dominant_track: range.dual_track.dominant_track,
              dominant_value: range.dual_track.dominant_value,
              cap_rate: range.dual_track.modifier_inputs.cap_rate,
              cap_rate_tier: range.dual_track.modifier_inputs.cap_rate_tier,
            }
          : null,
        modifier_inputs: {
          arv_mid: range.modifier_inputs.arv_mid,
          est_rehab: range.modifier_inputs.est_rehab,
          wholesale_fee: range.modifier_inputs.wholesale_fee,
          buyer_profit: range.modifier_inputs.buyer_profit,
          list_price: range.modifier_inputs.list_price,
          seller_motivation_score: range.modifier_inputs.seller_motivation_score,
          monthly_rent: range.modifier_inputs.monthly_rent,
          state: range.modifier_inputs.state ?? null,
          rehab_source: rehabPick.source,
        },
      },
    };
    return phase4;
  }

  const hasLegacyOffer =
    (listing.outreachOfferPrice != null && listing.outreachOfferPrice > 0) ||
    (listing.contractOfferPrice != null && listing.contractOfferPrice > 0);
  if (hasLegacyOffer) {
    return {
      mode: "legacy",
      outreach_offer_price: listing.outreachOfferPrice ?? null,
      contract_offer_price: listing.contractOfferPrice ?? null,
      list_price: listing.listPrice ?? null,
    };
  }

  return {
    mode: "no_math",
    list_price: listing.listPrice ?? null,
  };
}
