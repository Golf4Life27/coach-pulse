// Actionable-market gate (operator 2026-06-08, item 1).
//
// Do NOT spend Firecrawl credits verifying — or fire outreach into — a
// market we cannot PRICE or cannot ASSIGN. Two exclusion layers:
//
//   1. HARD-EXCLUDED states (wholesale-restrictive law): IL, MO, SC, NC,
//      OK, ND. We never operate here. Mirrors EXCLUDED_STATES in the
//      intake filter (kept in sync; duplicated as a const so this module
//      has no import cycle with the cron).
//   2. PAUSED markets: a market that is on hold at the contract layer.
//      Memphis is paused (non-assignable clause) — we can price it
//      (TN is a disclosure state) but cannot ASSIGN, so verifying/texting
//      Memphis listings burns credits on deals we can't close. Standing
//      constraint: do NOT reverse Memphis without an explicit operator go.
//
// Pure + config-driven so the gate is one source of truth for the
// freshness re-verify pass AND the outreach selector. NO mass registry
// edit — the pause lives in code, reversible by editing PAUSED_MARKETS.

import { getMarketForListing, openerArvPctMax } from "./registry";

/** Wholesale-restrictive — never operate. */
export const HARD_EXCLUDED_STATES: ReadonlySet<string> = new Set([
  "IL", "MO", "SC", "NC", "OK", "ND",
]);

/** Markets paused at the contract layer (can't assign). Matched on a
 *  normalized city or an explicit zip. Memphis = non-assignable clause. */
export const PAUSED_MARKETS: ReadonlyArray<{ label: string; state: string; cities: string[]; zips: string[]; reason: string }> = [
  {
    label: "Memphis",
    state: "TN",
    cities: ["memphis"],
    // The Memphis ZIP cluster currently in ZIP_Registry.
    zips: ["38109", "38114", "38116", "38118", "38127", "38128"],
    reason: "non_assignable_clause_paused_at_contract",
  },
];

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
