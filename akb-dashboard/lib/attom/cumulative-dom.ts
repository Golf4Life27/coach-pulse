// Relist-aware DOM — provenance + flag.
// @agent: orchestrator / appraiser
//
// THE PROBLEM (Strathmoor fixture): MLS DOM is a per-listing counter — any
// listing agent can withdraw and re-list to reset it to 0. Strathmoor's
// DOM_Calc_V2 showed 53 days; the cumulative DOM across its relist chain
// is ~87 days (operator CMA-verified). A negative-information signal that's
// trivially gameable is worse than no signal.
//
// THE FIX (this lib): structural surface for relist-aware DOM with explicit
// provenance. THREE source ranks, NONE fabricated:
//
//   1. operator_confirmed  — value supplied by the operator (CMA / Redfin
//                            cumulative DOM / MLS history). Wins absolutely.
//   2. attom_listings      — ATTOM Listings API (separate product, not yet
//                            wired — entitlement unverified). Returns null
//                            until probed live.
//   3. mls_dom_v2          — the gameable Airtable DOM_Calc_V2 figure. Last
//                            resort; tagged as such.
//
// When source is mls_dom_v2 AND we can detect a relist-suspicion (e.g.
// multiple intake_events on the record, or a recent createdTime mismatch
// with a much-earlier list date), surface `relist_suspected:true` so the
// caller treats the figure as a lower bound.
//
// Pure. No I/O. The fetcher is null until ATTOM listings-history is
// confirmed live.

export type DomSource = "operator_confirmed" | "attom_listings" | "mls_dom_v2" | "none";

export interface CumulativeDomResult {
  /** Cumulative DOM across the relist chain (best available). null when
   *  no source produces a value. */
  cumulativeDom: number | null;
  source: DomSource;
  /** True when the mls_dom_v2 figure is being used AND a relist-reset
   *  heuristic suggests true cumulative exposure is longer. Flag → comp
   *  audit, never auto-dispose. */
  relistSuspected: boolean;
  reason: string;
}

export interface CumulativeDomInputs {
  /** Operator-confirmed cumulative DOM (CMA / Redfin / MLS history). */
  operatorConfirmedDom?: number | null;
  /** ATTOM Listings API result. Null when not wired or not available. */
  attomListingsDom?: number | null;
  /** The Airtable DOM_Calc_V2 figure (gameable). */
  mlsDomV2?: number | null;
  /** Optional intake-event count on the record. >1 = suggests prior list/
   *  withdraw cycles → relist suspected. */
  intakeEventCount?: number | null;
  /** Optional list date the operator believes is the FIRST list date in
   *  the chain (ISO). When provided + much earlier than the implied first
   *  list date from mls_dom_v2, relist suspected. */
  firstListDateIso?: string | null;
  /** Current evaluation date (defaults to now). */
  now?: Date;
}

/** Pure: resolve cumulative DOM with provenance. Never fabricates a number;
 *  null when no source produces one. */
export function resolveCumulativeDom(input: CumulativeDomInputs): CumulativeDomResult {
  const now = input.now ?? new Date();

  // (1) operator_confirmed wins absolutely.
  if (typeof input.operatorConfirmedDom === "number" && Number.isFinite(input.operatorConfirmedDom) && input.operatorConfirmedDom >= 0) {
    return {
      cumulativeDom: Math.round(input.operatorConfirmedDom),
      source: "operator_confirmed",
      relistSuspected: false,
      reason: `cumulative DOM ${Math.round(input.operatorConfirmedDom)}d (operator-confirmed; CMA/Redfin/MLS history)`,
    };
  }

  // (2) ATTOM listings — separate ATTOM product, entitlement unverified.
  //     Honest gap: surfaced only when the caller supplies a real value.
  if (typeof input.attomListingsDom === "number" && Number.isFinite(input.attomListingsDom) && input.attomListingsDom >= 0) {
    return {
      cumulativeDom: Math.round(input.attomListingsDom),
      source: "attom_listings",
      relistSuspected: false,
      reason: `cumulative DOM ${Math.round(input.attomListingsDom)}d (ATTOM Listings API)`,
    };
  }

  // (3) mls_dom_v2 — gameable; surface relist-suspicion when heuristics fire.
  if (typeof input.mlsDomV2 === "number" && Number.isFinite(input.mlsDomV2) && input.mlsDomV2 >= 0) {
    const intakeMultiple = (input.intakeEventCount ?? 0) > 1;
    let firstListMismatch = false;
    if (input.firstListDateIso) {
      const t = Date.parse(input.firstListDateIso);
      if (Number.isFinite(t)) {
        const cumDays = (now.getTime() - t) / 86_400_000;
        firstListMismatch = cumDays > input.mlsDomV2 * 1.5;
      }
    }
    const relistSuspected = intakeMultiple || firstListMismatch;
    return {
      cumulativeDom: Math.round(input.mlsDomV2),
      source: "mls_dom_v2",
      relistSuspected,
      reason: relistSuspected
        ? `mls_dom_v2 ${Math.round(input.mlsDomV2)}d (⚠ relist suspected — ${intakeMultiple ? "multiple intake events" : ""}${intakeMultiple && firstListMismatch ? " + " : ""}${firstListMismatch ? "first-list mismatch" : ""}; treat as lower bound)`
        : `mls_dom_v2 ${Math.round(input.mlsDomV2)}d (gameable; relist not detected)`,
    };
  }

  return { cumulativeDom: null, source: "none", relistSuspected: false, reason: "no DOM source available" };
}
