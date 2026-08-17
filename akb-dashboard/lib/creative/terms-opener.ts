// Terms opener — the creative lane's first-touch message + send ordering.
// @agent: crier
//
// TEMPLATE DOCTRINE (operator 2026-08-17): the opener promises the OUTCOME
// (the seller's price, paid over time), never a structure — because the
// mortgage situation is unknown for ~all of the cohort, the MORTGAGE
// QUESTION IS FOLDED INTO THE FIRST TOUCH. Free & clear → clean seller
// finance; small balance → payoff/wrap at closing; big balance → the shape
// may be impossible, and the reply tells us before anything firms up.
// Nothing binding ever goes out on an unknown lien; the reply lane collects
// loan status at zero data cost and the terms math re-runs on real numbers.
//
// Two variants, because honesty: when our value cap pulled the price below
// the ask we never say "full asking price" — we name our number.
//
// PRIORITY (until PropStream lien enrichment lands): full-ask offers first
// (the strongest pitch), then buyer cash-on-cash descending (most
// dispo-able first). Pure functions; the route decides who is eligible.

import type { SellerFinanceOffer } from "@/lib/creative/seller-finance";

const usd = (n: number): string => `$${n.toLocaleString("en-US")}`;

/** First word of the agent's name, or a neutral greeting. */
export function greetName(agentName: string | null | undefined): string {
  const first = (agentName ?? "").trim().split(/\s+/)[0] ?? "";
  return first.length >= 2 ? first : "there";
}

/** The first-touch terms opener. Agent-facing (same channel as the cash lane). */
export function renderTermsOpener(input: {
  agentName: string | null | undefined;
  address: string;
  listPrice: number;
  offer: SellerFinanceOffer;
}): string {
  const { offer } = input;
  const name = greetName(input.agentName);
  const priceLine = offer.priceCappedToValue
    ? `I can do ${usd(offer.price)} on terms`
    : `I can work with the full ${usd(offer.price)} asking price`;
  return (
    `Hi ${name}, this is Alex with AKB Solutions. I'm interested in your listing at ${input.address}. ` +
    `Cash offers are going to come in well under the seller's number on this one, but ${priceLine} — ` +
    `${usd(offer.downPayment)} down and ${usd(offer.monthlyPayment)}/month until they're paid in full. ` +
    `More total money than any cash buyer, it just arrives over time. ` +
    `The exact structure depends on what's owed on the property — does the seller own it free and clear, or is there a mortgage? ` +
    `Happy to put it in writing if they're open.`
  );
}

/** Send-ordering score, higher first: full-ask offers beat capped ones, then
 *  buyer cash-on-cash (dispo-ability) breaks ties. Replaced by lien-aware
 *  ordering when the PropStream enrichment lands. */
export function termsPriority(offer: SellerFinanceOffer): number {
  return (offer.priceCappedToValue ? 0 : 1_000) + Math.min(999, Math.round(offer.buyerCashOnCash * 1000));
}
