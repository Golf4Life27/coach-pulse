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
// TONE DIRECTIVE (operator 2026-08-18, replacing v1 which read "gimmicky"):
// the message is about what the AGENT and SELLER get, not about us — the
// agent's commission is paid in full at closing like any normal sale, and
// the seller nets more than a cash sale IF they can wait on the payout.
// No salesman flourishes ("more total money than any cash buyer" is gone).
// LENGTH DIRECTIVE (operator, same day): these are TEXTS — keep it tight.
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
  // Offer sentences are OPERATOR-AUTHORED verbatim (2026-08-18): "Assuming the
  // numbers hold, I can offer the full $X asking price seller-financed. $Y at
  // closing, then $Z/month until the full amount is paid."
  //
  // WIGGLE-ROOM CLAUSE (operator 2026-08-19, after 1016 43rd Pl): this lane
  // offers 100% of ask — unlike cash at 40-65%, it has ZERO cushion. A hard
  // "I can offer $118,000" got an instant yes on a gut-stage flip our math
  // could not actually support, leaving a retrade or a dead deal as the only
  // exits.
  //
  // WHY THIS CLAUSE AND NOT A CONTINGENCY (operator's reasoning, verbatim
  // intent): "subject to walkthrough / inspection" is a CONTRACT contingency —
  // it only pays out AFTER papering, so discovery happens in escrow and the
  // exit is backing out: wasted time, wasted effort, burned agent. "Assuming
  // the numbers hold" conditions the OFFER, PRE-contract, so the adjustment
  // happens in conversation before anyone spends anything. Same protection,
  // spent at the cheap end of the funnel.
  //
  // Placed BEFORE the number so a later adjustment reads as contemplated, not
  // as a retrade. ONE hedge only — stacking them reads as someone who can't
  // close, and the confident number is what earns the reply.
  const priceLine = offer.priceCappedToValue
    ? `I can offer ${usd(offer.price)} seller-financed`
    : `I can offer the full ${usd(offer.price)} asking price seller-financed`;
  return (
    `Hi ${name} — Alex with AKB Solutions, about ${input.address}. ` +
    `Assuming the numbers hold, ${priceLine}. ` +
    `${usd(offer.downPayment)} at closing, then ${usd(offer.monthlyPayment)}/month until the full amount is paid. ` +
    `Your commission is paid in full at closing, and the seller nets more than any cash offer. ` +
    `Does the seller own it free and clear, or is there a mortgage? ` +
    `Glad to put it in writing if they're open.`
  );
}

/** Send-ordering score, higher first: full-ask offers beat capped ones, then
 *  buyer cash-on-cash (dispo-ability) breaks ties. Replaced by lien-aware
 *  ordering when the PropStream enrichment lands. */
export function termsPriority(offer: SellerFinanceOffer): number {
  return (offer.priceCappedToValue ? 0 : 1_000) + Math.min(999, Math.round(offer.buyerCashOnCash * 1000));
}
