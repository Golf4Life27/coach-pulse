// Market registry — national buy-box config layer.
// @agent: orchestrator
//
// BUILD MARKET AS A CONFIG ROW, NOT CODE. Every metro is a JSON row in
// lib/config/markets.json carrying its BBC buy-box parameters (ARV%Max,
// Max_Rehab, Max_Price, criteria) and three flags that gate live sourcing:
//
//   buyer_params_present   — operator/BBC supplied the row's params
//   arv_source_verified    — the ARV data source was probed live and
//                            confirmed to return real recorded sales for
//                            the market (e.g. ATTOM /salescomparables hits)
//   sourcing_allowed       — operator-policy gate. Hardcoded FALSE for
//                            restricted states (IL/MO/SC/NC/OK/ND) so
//                            those states are STRUCTURALLY unsourceable
//                            and cannot be resurrected by a config typo
//
// A market is LIVE-FOR-SOURCING only when ALL THREE are true.
//
// One code path serves every market — the deal-math engine reads params
// from this registry by the deal's market. No per-market branches.
//
// Pure. No I/O. Pin tests in lib/markets/registry.test.ts.

import marketsConfig from "@/lib/config/markets.json";

export interface MarketCriteria {
  beds_min: number | null;
  baths_min: number | null;
  year_built_min: number | null;
  sqft_min: number | null;
  sqft_max: number | null;
  property_types_allowed: string[] | null;
}

export interface MarketBuyerParams {
  /** ARV%Max — fraction (e.g. 0.6461 for Detroit). The deal-math engine
   *  uses this and only this. NOT a per-market multiplier on legacy ARV. */
  arv_pct_max: number;
  max_rehab_usd: number;
  max_price_usd: number | null;
  criteria: MarketCriteria;
}

export interface Market {
  id: string;
  label: string;
  state: string;
  counties: string[];
  zip_prefixes: string[];
  buyer_params_present: boolean;
  buyer_params: MarketBuyerParams | null;
  arv_source_verified: boolean;
  sourcing_allowed: boolean;
}

export interface MarketConfig {
  wholesale_fee_default: number;
  restricted_states: string[];
  markets: Market[];
}

// ── Load + freeze the operator-curated config ─────────────────────────
// JSON is a plain object; cast to our typed shape. Then enforce the
// restricted-states invariant at load time: any market in a restricted
// state has sourcing_allowed forced to false, regardless of what the JSON
// says. This is the structural anti-resurrection — a future config-typo
// flipping sourcing_allowed:true on (e.g.) an IL market cannot enable it.
function loadAndFreeze(raw: MarketConfig): MarketConfig {
  const restricted = new Set(raw.restricted_states.map((s) => s.toUpperCase()));
  const markets = raw.markets.map((m) => {
    if (restricted.has(m.state.toUpperCase())) {
      return { ...m, sourcing_allowed: false };
    }
    return m;
  });
  return { ...raw, markets };
}

const CONFIG: MarketConfig = loadAndFreeze(marketsConfig as unknown as MarketConfig);

export function getMarketConfig(): MarketConfig {
  return CONFIG;
}

export function listMarkets(): Market[] {
  return CONFIG.markets;
}

export function getRestrictedStates(): ReadonlySet<string> {
  return new Set(CONFIG.restricted_states.map((s) => s.toUpperCase()));
}

export function getWholesaleFeeDefault(): number {
  return CONFIG.wholesale_fee_default;
}

// ── Market resolution by deal ─────────────────────────────────────────
// Match a listing to a market by ZIP prefix first (most specific), then by
// state if no ZIP prefix match. Returns null when no market matches — the
// engine HOLDs in that case (never compute a deal against an unknown market).

export interface ListingLocation {
  state?: string | null;
  zip?: string | null;
}

/** Pure: resolve a listing to its market. ZIP prefix wins over state. */
export function getMarketForListing(l: ListingLocation): Market | null {
  const zip = (l.zip ?? "").trim();
  const state = (l.state ?? "").trim().toUpperCase();
  // ZIP-prefix match — longest prefix wins (in practice all are 2-digit, but
  // future markets may add 3-digit specificity).
  let best: { market: Market; prefixLen: number } | null = null;
  for (const m of CONFIG.markets) {
    for (const p of m.zip_prefixes) {
      if (zip.startsWith(p)) {
        if (best == null || p.length > best.prefixLen) best = { market: m, prefixLen: p.length };
      }
    }
  }
  if (best) return best.market;
  // Fall back to state-only when ZIP isn't in any prefix list — picks the
  // first matching market for the state. (Multiple markets per state is
  // permitted; ZIP-prefix match is the discriminator.)
  if (state) {
    const match = CONFIG.markets.find((m) => m.state.toUpperCase() === state);
    if (match) return match;
  }
  return null;
}

// ── Liveness ─────────────────────────────────────────────────────────
// A market is "live-for-sourcing" only when ALL three flags are true. This
// is the integrity gate the brief calls out: AVM-as-ARV is impossible
// because no market goes live until arv_source_verified is set by an
// operator-confirmed probe of real recorded sales. Same posture as the
// cap-confirmation gate (lib/landlord-hydrate.ts).

export interface MarketLivenessVerdict {
  live: boolean;
  reasons: string[];
}

export function isMarketLive(m: Market | null | undefined): MarketLivenessVerdict {
  const reasons: string[] = [];
  if (!m) {
    reasons.push("no market matched the deal's state/zip");
    return { live: false, reasons };
  }
  if (!m.buyer_params_present || m.buyer_params == null) {
    reasons.push(`buyer_params_present=false for ${m.id} (paste BBC row to flip on)`);
  }
  if (!m.arv_source_verified) {
    reasons.push(`arv_source_verified=false for ${m.id} (operator must probe ARV source live first)`);
  }
  if (!m.sourcing_allowed) {
    reasons.push(`sourcing_allowed=false for ${m.id} (restricted state or operator-disabled)`);
  }
  return { live: reasons.length === 0, reasons };
}

// ── NATIONAL OPENER BUY-BOX (2026-06-28, operator: "sweep the nation") ─────
// The ROUGH OPENER (lib/per-market-pricer) prices nationally off a default
// buy-box; the PRECISE CONTRACT lane (deal-math, isMarketLive) is UNTOUCHED and
// still demands a fully-verified market. Two-number doctrine: the opener is a
// rough, operator-manual-close-protected first text; the contract number is not.
//
// SAFE NATIONAL ROLLOUT — gates in order:
//   1. restricted states (IL/MO/SC/NC/OK/ND) → HOLD (never auto-offer).
//   2. a CONFIGURED market → price ONLY if its ARV source is operator-verified
//      (arv_source_verified). A configured-but-dormant market (e.g. the
//      non-disclosure Dallas/Memphis rows) HOLDs — no AVM-masquerading-as-ARV.
//   3. an UNCONFIGURED state:
//        - NON-DISCLOSURE (sold prices not public → comps unprovable) → HOLD.
//        - DISCLOSURE + non-restricted → the NATIONAL DEFAULT buy-box. Real
//          per-ZIP comps still gate it downstream: the auto-seed pulls real
//          recorded sales or writes DONT_PRICE → that ZIP HOLDs. The disclosure
//          distinction is the STATE-level ARV-source proof; the per-ZIP seed is
//          the fine-grained one.
//
// Non-disclosure states have no public sale-price record, so sold-comp data
// (the entire basis for ARV → the offer) can't be confirmed real. They stay
// dark until an operator-verified comp source is proven per-state.

/** The 12 non-disclosure states (sale prices not public record → ARV source
 *  unprovable). The opener HOLDs there until a source is verified per-state.
 *  (MO/ND also sit in restricted_states; harmless — restricted is checked
 *  first.)
 *
 *  Consolidation Night 2026-07-29: re-exported from the single source of
 *  truth in state-disclosure.ts — this module previously hardcoded its own
 *  copy, which silently disagreed with lib/markets/disclosure.ts about
 *  Alabama. See state-disclosure.ts for the documented AL delta and the
 *  pending operator question. */
export { NON_DISCLOSURE_STATES } from "@/lib/markets/state-disclosure";
import { NON_DISCLOSURE_STATES } from "@/lib/markets/state-disclosure";

export function isNonDisclosureState(state: string | null | undefined): boolean {
  return NON_DISCLOSURE_STATES.has((state ?? "").trim().toUpperCase());
}

/** National default OPENER buy-box for disclosure + non-restricted states with
 *  no configured market. ~0.70 (the proven blanket flip rule); per-market
 *  config refines it. Env-tunable; clamped to (0,1]. */
export const NATIONAL_OPENER_ARV_PCT_MAX = (() => {
  const raw = Number(process.env.NATIONAL_OPENER_ARV_PCT_MAX);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.70;
})();

export type OpenerArvPctMaxSource =
  | "configured_verified"            // a configured market with a verified ARV source
  | "national_default_disclosure"    // unconfigured disclosure + non-restricted state
  | "national_default_unverified"    // configured-but-dormant, fell back to the national default
  | "national_default_seed_verified" // non-disclosure ZIP w/ MLS-sold receipts, no in-state buy-box
  | "configured_seed_verified"       // ditto, and the metro has its OWN sourced buy-box → use it
  | "state_floor_seed_verified"      // ditto, no metro params → tightest sourced buy-box in-state
  | "hold_restricted"                // restricted state
  | "hold_configured_unverified"     // configured, unverified, AND the state cannot self-price
  | "hold_non_disclosure"            // non-disclosure state, ARV unprovable
  | "hold_no_state";                 // no state on the listing

export interface OpenerArvPctMaxResult {
  /** Null = HOLD (the opener cannot price). */
  arvPctMax: number | null;
  source: OpenerArvPctMaxSource;
}

/** Pure: the ROUGH OPENER's effective ARV%Max for a listing — encodes the
 *  national buy-box policy above. OPENER ONLY: the precise contract lane uses
 *  isMarketLive (all three flags), NEVER this. */
/** Pure: the TIGHTEST operator-sourced arv_pct_max among configured markets in
 *  a state, or null when the state has none. Used so a seeded ZIP in a metro
 *  with no buy-box of its own is never offered looser terms than a sibling
 *  metro whose buy-box IS sourced (San Antonio inheriting Dallas's 0.5883). */
export function tightestConfiguredPctInState(state: string): number | null {
  const st = (state ?? "").trim().toUpperCase();
  if (!st) return null;
  let best: number | null = null;
  for (const m of CONFIG.markets) {
    if (m.state.toUpperCase() !== st) continue;
    const p = m.buyer_params?.arv_pct_max;
    if (typeof p === "number" && Number.isFinite(p) && p > 0 && p <= 1) {
      best = best == null ? p : Math.min(best, p);
    }
  }
  return best;
}

export interface OpenerArvPctMaxOpts {
  /** True when the SUBJECT'S OWN ZIP carries a seed built from agent-reported
   *  MLS closings (see seedSelfPricesNonDisclosure). This is the evidence that
   *  lifts the non-disclosure hold — per ZIP, never per state. */
  selfPricingSeed?: boolean;
}

export function resolveOpenerArvPctMax(
  market: Market | null,
  state: string | null | undefined,
  opts?: OpenerArvPctMaxOpts,
): OpenerArvPctMaxResult {
  const st = (state ?? "").trim().toUpperCase();
  if (!st) return { arvPctMax: null, source: "hold_no_state" };
  if (getRestrictedStates().has(st)) return { arvPctMax: null, source: "hold_restricted" };
  const nonDisclosure = NON_DISCLOSURE_STATES.has(st);

  // ── THE NON-DISCLOSURE HOLD IS ABOUT EVIDENCE, NOT GEOGRAPHY ──────────
  // (operator ruling 2026-08-13, after the San Antonio dry run.)
  //
  // A non-disclosure state held because deed prices are not public, so no ARV
  // could be proven. That premise is FALSE for a ZIP whose seed was built from
  // "MLS Amount where MLS Status = SOLD": agents report closings to the MLS
  // even where the county publishes nothing, and that column measured 94.8%
  // transaction-shaped across 5,282 San Antonio rows (vs 23.0% for the
  // modelled Last Sale Amount that produced the $3,459/sqft 78211 fiction).
  //
  // THE DRY RUN THIS FIXES: 45 real SA listings, all 45 produced a correct
  // seed ARV, and all 45 were discarded here with arvPctMax=null before the
  // ARV was ever read. Writing 56 honest seeds changed nothing until this.
  //
  // Scoped deliberately to the ZIP, not the state: a TX ZIP with no MLS-sold
  // seed still HOLDs, exactly as before. Restricted states are unreachable
  // from here (returned above) and stay unreachable.
  //
  // ORDERING MATTERS, and a test caught it: this must apply ONLY where the
  // resolver would otherwise HOLD — never ahead of a verified market's own
  // buy-box. The national default (0.70) is LOOSER than a typical configured
  // one (Detroit 0.65), so checking the seed first would have quietly offered
  // MORE than a live market's buy-box permits. The seed lifts holds; it never
  // raises a rate that was already sourced.
  //
  // WHICH RATE THE SEED UNLOCKS (operator challenge 2026-08-13, and he was
  // right). A seed proves the ARV is real. It says NOTHING about what a
  // flipper in this metro will pay for that ARV — that is the buy-box, a
  // separate, operator/BBC-sourced number. Handing every seeded ZIP the
  // national 0.70 would have been exactly the "generic lazy math" the seed
  // work exists to kill, and in the loose direction: Dallas's sourced buy-box
  // is 0.5883, so a seeded TX ZIP would have been offered ~19% more of ARV
  // than the only in-state evidence supports. Wrong-low costs a "no";
  // wrong-high costs a contract that cannot be dispo'd — which is the exact
  // failure that killed the first volume push (4 under contract, none sold).
  //
  // So, in order of how much the number is actually KNOWN:
  //   1. this metro's own BBC buy-box, when it has one. arv_source_verified
  //      was gating precisely that number, and the seed IS that verification
  //      for this ZIP. Never override a sourced buy-box with a default.
  //   2. the TIGHTEST sourced buy-box in the SAME STATE. San Antonio has no
  //      params of its own, but Dallas does; offering looser than a sibling
  //      metro's operator-sourced number is not a defensible default.
  //   3. only then the national default.
  const seedUnlock = (): OpenerArvPctMaxResult | null => {
    if (!opts?.selfPricingSeed) return null;
    const own = market?.buyer_params?.arv_pct_max;
    if (typeof own === "number" && Number.isFinite(own) && own > 0 && own <= 1) {
      return { arvPctMax: own, source: "configured_seed_verified" };
    }
    const stateFloor = tightestConfiguredPctInState(st);
    if (stateFloor != null && stateFloor < NATIONAL_OPENER_ARV_PCT_MAX) {
      return { arvPctMax: stateFloor, source: "state_floor_seed_verified" };
    }
    return { arvPctMax: NATIONAL_OPENER_ARV_PCT_MAX, source: "national_default_seed_verified" };
  };
  if (market && market.buyer_params) {
    if (market.arv_source_verified && market.sourcing_allowed) {
      return { arvPctMax: market.buyer_params.arv_pct_max, source: "configured_verified" };
    }
    // ── ADDING A MARKET MUST NEVER MAKE THINGS WORSE THAN NOT ADDING IT ──
    // (operator 2026-08-07, on the third request to expand markets.)
    //
    // THE BUG. A dormant market HELD outright, while the very same listing in
    // a state with NO market entry at all priced off the national default. So
    // writing down what we know about a metro DISABLED it. Memphis is the
    // proof: 295 records — 33% of the entire eligible pool — every one holding
    // on hold_no_value_basis, purely because memphis_tn exists in markets.json
    // with arv_source_verified:false. Delete that entry and TN prices today.
    //
    // The fallback is strictly MORE conservative than the config it replaces:
    // Memphis's configured buy-box is 0.7175 and the national default is 0.70,
    // so we offer LESS, not more. There is no version of this where holding
    // was the safe choice and pricing at 0.70 is the reckless one — we already
    // price every unconfigured disclosure market at exactly this number.
    //
    // What arv_source_verified still gates is the market's OWN buy-box, and
    // the precise contract lane (isMarketLive, all three flags) is untouched.
    // A dormant market in a state that cannot self-price still HOLDs.
    if (!nonDisclosure) {
      return { arvPctMax: NATIONAL_OPENER_ARV_PCT_MAX, source: "national_default_unverified" };
    }
    return seedUnlock() ?? { arvPctMax: null, source: "hold_configured_unverified" };
  }
  if (nonDisclosure) return seedUnlock() ?? { arvPctMax: null, source: "hold_non_disclosure" };
  return { arvPctMax: NATIONAL_OPENER_ARV_PCT_MAX, source: "national_default_disclosure" };
}

/** Convenience: just the number (null = HOLD). */
export function openerArvPctMax(
  market: Market | null,
  state: string | null | undefined,
  opts?: OpenerArvPctMaxOpts,
): number | null {
  return resolveOpenerArvPctMax(market, state, opts).arvPctMax;
}
