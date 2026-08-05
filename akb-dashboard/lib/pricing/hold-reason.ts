// HOLD-reason classifier (operator volume-worry instrument, 2026-06-28).
// @agent: appraiser/crier
//
// THE WORRY: now that the opener is "value-anchored or HOLD" (never list-
// anchored — see lib/per-market-pricer), the operator fears a HOLD pile so
// large it becomes endless manual decisions and starves volume.
//
// THE ANSWER this module makes measurable: a HOLD is NOT one undifferentiated
// stack of judgment calls. It splits by WHY it held and, crucially, WHO owns
// the next step — and most holds are owned by the SYSTEM, not the operator:
//
//   needs_seed       → the ZIP just isn't ARV-seeded yet (or its stored ARV is
//                      contaminated). The crawler's auto-seed loop values it on
//                      the next pass and it becomes a SEND. No human. The single
//                      biggest lever on the hold rate is seeding coverage.
//   no_market_buybox → the market has no arv_pct_max configured. ONE-TIME
//                      registry config unlocks every listing in it — not a
//                      per-record decision.
//   seed_dont_price  → the ZIP's comps are too thin/noisy to value (DONT_PRICE
//                      sentinel). Cached as skip; no per-record human action.
//   cash_no_pencil   → value IS known and cash simply does not work (renovated
//                      ARV below the asking price, or rehab eats the buy-box).
//                      These were NEVER cash deals — the old system over-offered
//                      on them. They route to the CREATIVE / subject-to lane,
//                      not to a one-by-one manual call.
//   operator_review  → the genuine residual that actually needs Alex.
//
// So the headline the dry-run can now print: "X% of holds are system-owned
// (auto-seed/skip), Y% creative-lane, Z% you" — turning a fear into a number.
//
// Pure. No I/O. Inputs are the lib/per-market-pricer result fields + seed/
// market context the caller already has.

export type HoldCategory =
  | "value_send"           // NOT a hold — a value-anchored opener was produced
  | "over_list_tripwire"   // computed opener exceeded the 0.85×list never-over-list cap
  | "failed_corroboration" // computed opener failed the pre-send corroboration allowlist gate
  | "needs_seed"        // no/contaminated ARV in a priceable market → auto-seed fixes it
  | "no_market_buybox"  // market has no arv_pct_max → one-time market config
  | "seed_dont_price"   // ZIP comps too thin/noisy (DONT_PRICE) → cached skip
  | "cash_no_pencil"    // value known, cash can't work → creative/subject-to candidate
  | "operator_review";  // residual / ambiguous → genuinely needs the operator

export type HoldOwner =
  | "none"              // it sent — nobody
  | "auto_seed"         // the crawler's seed loop (no human)
  | "configure_market"  // a one-time market-registry edit (not per-record)
  | "data_limited"      // cached do-not-price; effectively skip (no per-record human)
  | "creative_lane"     // route to the creative / subject-to pipeline
  | "operator";         // genuinely needs Alex

export interface HoldClassifyInput {
  /** lib/per-market-pricer PricerResult.opener — null means HOLD. */
  opener: number | null;
  /** PricerResult.arvDistrusted (renovated ARV came in below the list price). */
  arvDistrusted: boolean;
  /** PricerResult.flooredToFallback (buy-box opener below the low-opener floor). */
  flooredToFallback: boolean;
  /** PricerResult.flagReseed (the ARV is low-confidence — a re-pull could fix it). */
  flagReseed: boolean;
  /** OpenerWithSeedResult.arvSource — did any value basis feed the pricer? */
  arvSource: "seed_renovated" | "stored" | "none";
  /** The ZIP's ARV seed is the DONT_PRICE sentinel (comps too thin/noisy). */
  seedDontPrice: boolean;
  /** The market has a sourced arv_pct_max (is priceable at all). */
  marketHasBuybox: boolean;
  /** lib/per-market-pricer PricerResult.overListTripwire — the value-anchored
   *  opener exceeded NEVER_OVER_LIST_PCT (0.85) × list and was HELD rather
   *  than clamped/sent (the retired 0.85×list producer). Optional + defaults
   *  to false so the existing opener-dry-run caller (which does not pass it)
   *  keeps classifying these under the prior generic buckets unchanged. */
  overListTripwire?: boolean;
  /** OpenerWithSeedResult.corroborationFlags — non-empty means the computed
   *  opener failed lib/opener-sanity-gate's pre-send allowlist and was
   *  converted to a HOLD (independent of the ARV-sanity gate above).
   *  Optional + defaults to empty so the existing opener-dry-run caller
   *  (which does not pass it) is unaffected. */
  corroborationFlags?: readonly string[];
}

export interface HoldClassification {
  category: HoldCategory;
  owner: HoldOwner;
  /** True when NO human action is needed — the system auto-fixes (seed) or
   *  skips (do-not-price), or it sent. This is the operator's headline: the
   *  share of holds that never reach the desk. */
  automatable: boolean;
  detail: string;
}

/** Pure: classify a priced record's HOLD by reason + owner. */
export function classifyHold(i: HoldClassifyInput): HoldClassification {
  // Not a hold at all — a value-anchored opener was produced.
  if (i.opener != null) {
    return {
      category: "value_send",
      owner: "none",
      automatable: true,
      detail: "value-anchored opener produced — sends autonomously",
    };
  }

  // OVER-LIST TRIPWIRE (Hole A): the value-anchored opener exceeded 0.85×list
  // and was held rather than clamped/sent. Checked BEFORE arvDistrusted
  // because the pricer never sets arvDistrusted for this guard — without
  // this branch the record would fall through to the generic cash_no_pencil
  // bucket at the bottom and be indistinguishable from a rehab-ate-the-
  // buybox hold. Both the reseed-worthy and STRONG-seed cases surface to
  // the operator (per-market-pricer's overListTripwireGuard: "Both belong
  // to the operator").
  if (i.overListTripwire) {
    return {
      category: "over_list_tripwire",
      owner: "operator",
      automatable: false,
      detail:
        "computed opener exceeded the 0.85×list never-over-list tripwire — a genuine deep-discount " +
        "listing or an inflated/broken ARV input; HELD for operator review (Type 2C); the 0.85 clamp is " +
        "retired and never produces a number",
    };
  }

  // FAILED CORROBORATION (pre-send allowlist gate): a computed opener that
  // survived every pricer guard still failed an independent sanity check
  // (e.g. size extrapolation, $/sqft out of range) and was converted to a
  // HOLD. Checked BEFORE arvDistrusted because opener-pricing.ts marks
  // these arvDistrusted=true too (to route them through the same "no value
  // basis" send-guard label) — without this branch they are indistinguishable
  // from a genuine ARV-below-list hold, even though the root cause and the
  // fix (re-run corroboration inputs, not necessarily re-seed) differ.
  if (i.corroborationFlags && i.corroborationFlags.length > 0) {
    return {
      category: "failed_corroboration",
      owner: "operator",
      automatable: false,
      detail: `computed opener failed the pre-send corroboration allowlist gate [${i.corroborationFlags.join(", ")}] — an independent sanity signal red-flagged it; HELD for operator review`,
    };
  }

  // ARV came in below the asking price.
  if (i.arvDistrusted) {
    return i.flagReseed
      ? {
          category: "needs_seed",
          owner: "auto_seed",
          automatable: true,
          detail:
            "ARV below list but LOW-CONFIDENCE — a re-seed (clean renovated $/sqft) may lift it above list and send; the crawler handles it",
        }
      : {
          category: "cash_no_pencil",
          owner: "creative_lane",
          automatable: false,
          detail:
            "trusted renovated ARV is BELOW the asking price — cash can't pencil at list; creative/subject-to candidate (never a cash send)",
        };
  }

  // Buy-box opener fell below the low-opener floor (a broken-looking micro-number).
  if (i.flooredToFallback) {
    return {
      category: "cash_no_pencil",
      owner: "creative_lane",
      automatable: false,
      detail: "buy-box opener below the floor — cash pencils too thin; creative/subject-to or pass",
    };
  }

  // No trusted value basis — split by WHY there's no value.
  if (i.seedDontPrice) {
    return {
      category: "seed_dont_price",
      owner: "data_limited",
      automatable: true,
      detail:
        "ZIP comps too thin/noisy to value (DONT_PRICE) — cached as skip, no per-record decision; revisit with manual comps only if the ZIP matters",
    };
  }
  if (!i.marketHasBuybox) {
    return {
      category: "no_market_buybox",
      owner: "configure_market",
      automatable: false,
      detail: "market has no buy-box configured — a ONE-TIME registry edit unlocks every listing in it (not a per-record decision)",
    };
  }
  if (i.arvSource === "none") {
    return {
      category: "needs_seed",
      owner: "auto_seed",
      automatable: true,
      detail: "priceable market, ZIP not yet ARV-seeded — the crawler's auto-seed will value it and send; no human",
    };
  }

  // Value existed AND the market has a buy-box, yet it still held → the buy-box
  // did not pencil (rehab ate it). Cash is no deal here.
  return {
    category: "cash_no_pencil",
    owner: "creative_lane",
    automatable: false,
    detail: "value known but the buy-box did not pencil (rehab eats it) — cash is no deal; creative/subject-to or pass",
  };
}
