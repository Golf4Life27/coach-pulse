// Outreach economics guard — 2026-06-05.
// @agent: orchestrator
//
// Two operator-locked hard prerequisites the H2 (Crier) sender must pass
// BEFORE any SMS goes out. Both replace existing PHANTOM gates that read
// fields which don't exist in the Listings_V1 schema and therefore
// silently let everything through (or silently blocked deal-action's
// safety-check path — the gates were dead code either way).
//
//   1. >85%-of-list block — the offer amount in the outgoing message
//      may not exceed 85% of List_Price. The crawler intake script
//      mechanically generates an offer at 65% of List_Price; an offer
//      above 85% is either a math bug, an operator override that
//      bypassed the floor, or a fee-inflated number. BLOCK.
//
//   2. First-outreach hydration prerequisite — a first outreach (no
//      prior Last_Outreach_Date) requires real ARV + rehab inputs
//      before sending an offer. Previously gated on `preOfferScreenAt`
//      (schema field doesn't exist → always-null → either always-block
//      from deal-action or always-pass-through from h2). Replaces that
//      phantom with the real fields: `arvValidatedAt` AND
//      `rehabEstimatedAt`.
//
// Both checks are PURE — no I/O. Caller passes listing + message body.

/** The 85% threshold. Operator-tunable via env without a deploy. The
 *  intake script targets 65%, so 85% gives operator headroom for
 *  per-deal upward adjustments — but never further than 85%. */
export const OFFER_OVER_LIST_BLOCK_PCT = (() => {
  const raw = process.env.OUTREACH_MAX_OFFER_OVER_LIST_PCT;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.85;
})();

export interface OfferEconomicsCheck {
  ok: boolean;
  offerAmount: number | null;
  listPrice: number | null;
  ratio: number | null;
  blockedBecause: string | null;
}

/** Pure: extract the offer dollar amount from a Crier-shaped message
 *  body. Looks for "cash offer at $N,NNN" / "offer of $N,NNN" / generic
 *  "$N,NNN" patterns. Returns the FIRST plausible offer amount or null.
 *  We bound the result to a residential offer range to avoid
 *  accidentally picking up a list-price echo or a phone number. */
export function extractOfferAmountFromMessage(body: string): number | null {
  if (!body) return null;
  const PHRASES = [/cash offer at\s*\$\s*([\d,]+)/i, /cash offer of\s*\$\s*([\d,]+)/i, /offer at\s*\$\s*([\d,]+)/i, /offer of\s*\$\s*([\d,]+)/i];
  for (const re of PHRASES) {
    const m = body.match(re);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 1_000 && n < 5_000_000) return Math.round(n);
    }
  }
  // Fallback: first $-amount in the body.
  const m = body.match(/\$\s*([\d,]+)/);
  if (m) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 1_000 && n < 5_000_000) return Math.round(n);
  }
  return null;
}

/** Pure: BLOCK when the parsed offer amount > thresholdPct × listPrice.
 *  When inputs are insufficient to compute the ratio (missing offer or
 *  list price), the check PASSES — the caller is expected to have
 *  separate hydration guards (checkFirstOutreachHydration). The intent
 *  here is to catch a numerically-anomalous offer, not to gate on
 *  missing data. */
export function checkOfferOverList(
  messageBody: string,
  listPrice: number | null | undefined,
  thresholdPct: number = OFFER_OVER_LIST_BLOCK_PCT,
): OfferEconomicsCheck {
  const offerAmount = extractOfferAmountFromMessage(messageBody);
  const lp = typeof listPrice === "number" && Number.isFinite(listPrice) && listPrice > 0 ? listPrice : null;
  if (offerAmount == null || lp == null) {
    return { ok: true, offerAmount, listPrice: lp, ratio: null, blockedBecause: null };
  }
  const ratio = offerAmount / lp;
  if (ratio > thresholdPct) {
    return {
      ok: false,
      offerAmount,
      listPrice: lp,
      ratio: Math.round(ratio * 1000) / 1000,
      blockedBecause:
        `offer $${offerAmount.toLocaleString()} > ${Math.round(thresholdPct * 100)}% of list $${lp.toLocaleString()} (ratio ${(ratio * 100).toFixed(1)}%) — too aggressive vs. list; refuse send`,
    };
  }
  return { ok: true, offerAmount, listPrice: lp, ratio: Math.round(ratio * 1000) / 1000, blockedBecause: null };
}

export interface FirstOutreachHydrationCheck {
  ok: boolean;
  isFirstOutreach: boolean;
  missing: string[];
  blockedBecause: string | null;
}

/** Pure: a FIRST outreach (no prior Last_Outreach_Date) requires that
 *  the ARV and rehab pipelines have both run, so the offer is grounded.
 *  Replaces the phantom `preOfferScreenAt` gate that always read null.
 *  Returns ok:true (no gate) when this isn't a first outreach. */
export function checkFirstOutreachHydration(input: {
  lastOutreachDate: string | null | undefined;
  arvValidatedAt: string | null | undefined;
  rehabEstimatedAt: string | null | undefined;
}): FirstOutreachHydrationCheck {
  const isFirstOutreach = !input.lastOutreachDate;
  if (!isFirstOutreach) {
    return { ok: true, isFirstOutreach, missing: [], blockedBecause: null };
  }
  const missing: string[] = [];
  if (!input.arvValidatedAt) missing.push("arvValidatedAt");
  if (!input.rehabEstimatedAt) missing.push("rehabEstimatedAt");
  if (missing.length === 0) {
    return { ok: true, isFirstOutreach, missing: [], blockedBecause: null };
  }
  return {
    ok: false,
    isFirstOutreach,
    missing,
    blockedBecause:
      `first outreach requires hydrated pricing inputs; missing: ${missing.join(", ")}. Run ARV + rehab pipelines first`,
  };
}
