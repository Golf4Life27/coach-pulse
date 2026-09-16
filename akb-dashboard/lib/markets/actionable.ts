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
export function isPriceableMarket(
  input: MarketInput,
  seededZips: ReadonlySet<string>,
  /** ZIPs whose seed can lift a non-disclosure hold (listSelfPricingArvZips).
   *  Omitted → prior behaviour: the whole non-disclosure state stays excluded.
   *
   *  THIS PARAMETER IS WHY SAN ANTONIO HAD NO INVENTORY. The opener ruling of
   *  2026-08-13 let a seeded TX ZIP price, but this gate — which decides what
   *  intake will even scrape — still asked the state-level question and
   *  answered "no", so no SA listing could enter the table to be priced. A
   *  market unlock is not finished until every downstream copy of the premise
   *  is threaded too. */
  selfPricingZips?: ReadonlySet<string>,
): MarketVerdict {
  const base = isActionableMarket(input);
  if (!base.actionable) return base;
  const market = getMarketForListing({ state: input.state, zip: input.zip });
  const zipKey = (input.zip ?? "").trim();
  const selfPricingSeed = zipKey !== "" && (selfPricingZips?.has(zipKey) ?? false);
  if (openerArvPctMax(market, input.state, { selfPricingSeed }) == null) {
    return { actionable: false, reason: "opener_holds_market" };
  }
  const zip = (input.zip ?? "").trim();
  if (!zip || !seededZips.has(zip)) return { actionable: false, reason: "no_seeded_zip" };
  return { actionable: true, reason: null };
}

/** Pure: is this market priceable for the FRESHNESS RE-VERIFY lane
 *  specifically (2026-09-16, the 114-record verify_stale floor)?
 *
 *  isPriceableMarket's seeded-ZIP + opener-buy-box gate exists because the
 *  VALUE-ANCHORED pricer (priceOpenerWithSeed) needs a comp seed to produce
 *  a number. In LIST-ANCHOR mode (operator ruling 2026-08-30, two-stage
 *  doctrine) the first-contact opener is pct x list — it needs no seed and
 *  no buy-box — and the send lane's own eligibility (isH2Eligible /
 *  outreachReadyReason) and ZIP coverage (app/api/cron/h2-outreach
 *  resolveCoverage, unioning getActiveIntakeZips() — the ~230-ZIP registry —
 *  into coverage in list-anchor mode) never require a seeded ZIP either.
 *
 *  The freshness route applied isPriceableMarket's seed/buy-box gate
 *  regardless of mode, so a record in a registry-covered, non-seeded ZIP
 *  was send-eligible and send-covered but could NEVER be re-verified Active
 *  within the freshness window — it could never cross isOutreachFresh, so
 *  it could never reach the Sendable queue. Evidence: crier/
 *  h2_supply_floor_below, 2026-09-14, "Sendable queue depth 0 < floor 10 …
 *  114 records eligible in every respect except the 48h Last_Verified
 *  window", cohort pinned at 114 since.
 *
 *  Fix: in list-anchor mode, a registry-covered ZIP clears ONLY the
 *  seed/buy-box reasons (`no_seeded_zip`, `opener_holds_market`) — every
 *  hard exclusion (missing state, wholesale-restricted state, paused
 *  market) still applies unchanged, and every other mode/ZIP falls back to
 *  the unmodified isPriceableMarket verdict. This never loosens a SEND
 *  gate — it only lets a record get RE-VERIFIED so it can reach the send
 *  lane's own, untouched gates. */
export function isFreshnessPriceableMarket(
  input: MarketInput,
  seededZips: ReadonlySet<string>,
  selfPricingZips: ReadonlySet<string> | undefined,
  opts: { listAnchorModeActive: boolean; registryZips: ReadonlySet<string> },
): MarketVerdict {
  const verdict = isPriceableMarket(input, seededZips, selfPricingZips);
  if (verdict.actionable) return verdict;
  if (verdict.reason !== "no_seeded_zip" && verdict.reason !== "opener_holds_market") return verdict;
  if (!opts.listAnchorModeActive) return verdict;
  const zip = (input.zip ?? "").trim();
  if (zip && opts.registryZips.has(zip)) return { actionable: true, reason: null };
  return verdict;
}
