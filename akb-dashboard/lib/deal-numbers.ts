// Deal display numbers — the ONE doctrine-safe resolver for "what offer and
// ceiling to show" on cards, tiles, and briefings (P1.1, 2026-07-13).
// @agent: ledger
//
// THE BUG: the serializer read Outreach_Offer_Price (the empty legacy 65%
// slot) for every deal → "no price on record" everywhere, while the real
// sent number lived in Rough_Opener_Amount (value-anchored opener) or the
// delivery stamp. Meanwhile the ceiling tile fell back to MAO_V1 — the
// RETIRED List×0.65 formula (INVARIANTS §2) — showing a list-anchored number
// as "your ceiling."
//
// THE RULE this module enforces, in one place:
//   OFFER  = delivery-stamped number (authoritative) → Contract_Offer_Price
//            (negotiated) → Rough_Opener_Amount (value-anchored opener) →
//            Outreach_Offer_Price (legacy). NEVER a formula field
//            (MAO_V1 / Offer_Start / Offer_Max / Offer_Target = List×0.65).
//   CEILING = Underwritten_MAO (value-anchored) → Underwritten_Property_MAO.
//            NEVER MAO_V1. If neither is set (un-underwritten legacy deal),
//            the ceiling is UNKNOWN — show nothing, never the 65% number.
//
// PURE. No I/O.

import type { Listing } from "@/lib/types";

export type OfferSource =
  | "delivery_stamp"
  | "contract_offer_price"
  | "rough_opener_amount"
  | "outreach_offer_price"
  | "none";

export interface DisplayOffer {
  amount: number | null;
  source: OfferSource;
}

/** A subset of Listing this resolver reads — lets card serializers that only
 *  fetch a few fields build a partial and still resolve safely. */
export interface OfferFields {
  contractOfferPrice?: number | null;
  roughOpenerAmount?: number | null;
  outreachOfferPrice?: number | null;
}

function pos(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** Resolve the offer to DISPLAY. `stampedOffer` is the delivery-stamped
 *  number (extractStickyOffer(notes)?.offer) when the caller has notes in
 *  hand — the deal room passes it; the glance-level card may pass null and
 *  resolve from fields only. A formula field is never consulted. */
export function resolveDisplayOffer(fields: OfferFields, stampedOffer: number | null = null): DisplayOffer {
  const stamp = pos(stampedOffer);
  if (stamp != null) return { amount: stamp, source: "delivery_stamp" };
  const contract = pos(fields.contractOfferPrice);
  if (contract != null) return { amount: contract, source: "contract_offer_price" };
  const rough = pos(fields.roughOpenerAmount);
  if (rough != null) return { amount: rough, source: "rough_opener_amount" };
  const outreach = pos(fields.outreachOfferPrice);
  if (outreach != null) return { amount: outreach, source: "outreach_offer_price" };
  return { amount: null, source: "none" };
}

/** Resolve the CEILING to display — value-anchored MAO only. Returns null
 *  (unknown) rather than ever surfacing the retired 65%-of-list MAO_V1. */
export function resolveDisplayCeiling(l: Pick<Listing, "underwrittenMao"> & { underwrittenPropertyMao?: number | null }): number | null {
  return pos(l.underwrittenMao) ?? pos(l.underwrittenPropertyMao);
}
