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
 *  first.) */
export const NON_DISCLOSURE_STATES: ReadonlySet<string> = new Set([
  "AK", "ID", "KS", "LA", "MS", "MO", "MT", "ND", "NM", "TX", "UT", "WY",
]);

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
  | "hold_restricted"                // restricted state
  | "hold_configured_unverified"     // configured but ARV source not verified (dormant)
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
export function resolveOpenerArvPctMax(
  market: Market | null,
  state: string | null | undefined,
): OpenerArvPctMaxResult {
  const st = (state ?? "").trim().toUpperCase();
  if (!st) return { arvPctMax: null, source: "hold_no_state" };
  if (getRestrictedStates().has(st)) return { arvPctMax: null, source: "hold_restricted" };
  if (market && market.buyer_params) {
    return market.arv_source_verified && market.sourcing_allowed
      ? { arvPctMax: market.buyer_params.arv_pct_max, source: "configured_verified" }
      : { arvPctMax: null, source: "hold_configured_unverified" };
  }
  if (NON_DISCLOSURE_STATES.has(st)) return { arvPctMax: null, source: "hold_non_disclosure" };
  return { arvPctMax: NATIONAL_OPENER_ARV_PCT_MAX, source: "national_default_disclosure" };
}

/** Convenience: just the number (null = HOLD). */
export function openerArvPctMax(market: Market | null, state: string | null | undefined): number | null {
  return resolveOpenerArvPctMax(market, state).arvPctMax;
}
