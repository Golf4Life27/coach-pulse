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

import { getMarketForListing } from "./registry";

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

/** Pure: is this market PRICEABLE — can we actually make an MAO-checked offer
 *  in it? Stricter than isActionableMarket: in addition to not being excluded
 *  or paused, the market must have (a) a SOURCED arv_pct_max in the buy-box
 *  registry AND (b) a SEEDED ZIP buyer-median (passed in as `seededZips`).
 *  Allowed-but-unpriceable markets — TX (San Antonio / Dallas / Houston),
 *  non-disclosure with no usable ARV source and no seeded median — are
 *  excluded so we never spend Firecrawl on a deal we can't price. The
 *  caller loads `seededZips` once (lib/buyer-median-store.listSeededZips). */
export function isPriceableMarket(input: MarketInput, seededZips: ReadonlySet<string>): MarketVerdict {
  const base = isActionableMarket(input);
  if (!base.actionable) return base;
  const market = getMarketForListing({ state: input.state, zip: input.zip });
  const arvPct = market?.buyer_params?.arv_pct_max ?? null;
  if (arvPct == null) return { actionable: false, reason: "no_sourced_arv_pct_max" };
  const zip = (input.zip ?? "").trim();
  if (!zip || !seededZips.has(zip)) return { actionable: false, reason: "no_seeded_buyer_median" };
  return { actionable: true, reason: null };
}
