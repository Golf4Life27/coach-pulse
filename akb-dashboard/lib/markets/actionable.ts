// Actionable-market gate (operator 2026-06-08, item 1).
//
// Do NOT spend Firecrawl credits verifying — or fire outreach into — a
// market we cannot PRICE or cannot ASSIGN. Two exclusion layers:
//
//   1. HARD-EXCLUDED states (wholesale-restrictive law): IL, MO, SC, NC,
//      OK, ND. We never operate here. Mirrors EXCLUDED_STATES in the
//      intake filter (kept in sync; duplicated as a const so this module
//      has no import cycle with the cron).
//   2. PAUSED markets: a market on hold at the OUTREACH layer (can't
//      price OR can't work it at all). Currently EMPTY.
//
//      Memphis (TN) is NO LONGER paused here (operator 2026-07-23):
//      Memphis is OPEN for outreach. TN assignability is enforced at the
//      MONEY DOORS instead — PE-04 (assignment-clause attestation, every
//      state, at EMD) and PC-16 (TN Memphis-compliant assignment language,
//      at contract). No earnest money leaves on a TN deal until assignment
//      is confirmed with the seller and in the contract. Blocking outreach
//      was the wrong layer; the EMD/contract gates are the right one.
//
// Pure + config-driven so the gate is one source of truth for the
// freshness re-verify pass AND the outreach selector. The pause lives in
// code, reversible by editing PAUSED_MARKETS.

import { getMarketForListing, openerArvPctMax } from "./registry";

/** Wholesale-restrictive — never operate. */
export const HARD_EXCLUDED_STATES: ReadonlySet<string> = new Set([
  "IL", "MO", "SC", "NC", "OK", "ND",
]);

/** Markets paused at the OUTREACH layer. Matched on a normalized city or an
 *  explicit zip. Currently EMPTY — Memphis was unpaused 2026-07-23 (TN
 *  assignability now enforced at EMD/contract via PE-04 + PC-16, not by
 *  blocking outreach). Re-add an entry here to pause a market outright. */
export const PAUSED_MARKETS: ReadonlyArray<{ label: string; state: string; cities: string[]; zips: string[]; reason: string }> = [];

export interface MarketInput {
  state: string | null | undefined;
  city?: string | null | undefined;
  zip?: string | null | undefined;
}

export interface MarketVerdict {
  actionable: boolean;
  reason: string | null;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** Pure: can we work this market (price + assign + close)? */
export function isActionableMarket(input: MarketInput): MarketVerdict {
  const state = (input.state ?? "").trim().toUpperCase();
  if (!state) return { actionable: false, reason: "state_missing" };
  if (HARD_EXCLUDED_STATES.has(state)) return { actionable: false, reason: "wholesale_restricted_state" };

  const city = norm(input.city);
  const zip = (input.zip ?? "").trim();
  for (const m of PAUSED_MARKETS) {
    if (m.state !== state) continue;
    const cityHit = city !== "" && m.cities.some((c) => city.includes(c));
    const zipHit = zip !== "" && m.zips.includes(zip);
    if (cityHit || zipHit) return { actionable: false, reason: `paused_${m.label.toLowerCase()}_${m.reason}` };
  }
  return { actionable: true, reason: null };
}

/** Pure: is this market PRICEABLE — can we actually fire a ROUGH OPENER into it?
 *  Stricter than isActionableMarket: in addition to not being excluded or paused,
 *  (a) the OPENER's national buy-box must price the market (openerArvPctMax != null)
 *  AND (b) the ZIP must be SEEDED (passed in as `seededZips` — the union of the
 *  buyer-median store and the ARV $/sqft store).
 *
 *  Gate (a) is the OPENER lane, NOT the strict contract lane. Intake feeds the
 *  opener send, and the opener prices any disclosure + non-restricted state off
 *  the national default (0.70) with NO configured market, while it HOLDs
 *  non-disclosure (TX etc.), restricted (IL etc.), and configured-but-unverified
 *  (dormant Dallas/Memphis) markets. Gating intake on the configured-market
 *  arv_pct_max — the old contract-grade check — blocked every cast-wide frontier
 *  metro the opener could already price (observed 2026-06-30: Indianapolis /
 *  Birmingham / Atlanta ARV-seeded and opener-priceable, but intake rejected
 *  every listing market_not_priceable). Aligning (a) to openerArvPctMax makes
 *  intake accept exactly what the opener can send — no more, no less.
 *
 *  Gate (b) (per-ZIP seed) stays: real comps must exist, or the opener
 *  self-HOLDs downstream anyway (computeRoughOpenerCeiling). The caller loads
 *  `seededZips` once (listSeededZips ∪ listArvSeededZips). */
export function isPriceableMarket(input: MarketInput, seededZips: ReadonlySet<string>): MarketVerdict {
  const base = isActionableMarket(input);
  if (!base.actionable) return base;
  const market = getMarketForListing({ state: input.state, zip: input.zip });
  if (openerArvPctMax(market, input.state) == null) {
    return { actionable: false, reason: "opener_holds_market" };
  }
  const zip = (input.zip ?? "").trim();
  if (!zip || !seededZips.has(zip)) return { actionable: false, reason: "no_seeded_zip" };
  return { actionable: true, reason: null };
}
