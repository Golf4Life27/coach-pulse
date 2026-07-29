// THE single source of truth for state disclosure classification.
// @agent: orchestrator (Consolidation Night 2026-07-29, item A)
//
// WHY THIS FILE EXISTS. Until tonight this concept lived in TWO hardcoded
// lists that DISAGREED: lib/markets/registry.ts carried the legal 12 (no
// Alabama) and gated openers/frontier-staging on it, while
// lib/markets/disclosure.ts carried 13 (with Alabama, "for pricing safety")
// and picked the buyer-ceiling path on it. Nobody decided that split — it
// accreted. Every dual-list concept in this codebase eventually produced a
// bug (two send paths, two spend meters, two tax resolvers), so both modules
// now import from here and the delta is EXPLICIT, documented, and pinned by
// a parity test.
//
// TWO QUESTIONS, TWO SETS — deliberately not merged, because they answer
// different questions:
//
// 1. NON_DISCLOSURE_STATES — "does state law make sale prices public
//    record?" The classic legal 12. Used to HOLD openers (ARV unprovable
//    without recorded sales) and to skip frontier staging.
//
// 2. BUYER_MEDIAN_UNRELIABLE_STATES — "can we trust an InvestorBase
//    buyer-median export here?" The legal 12 PLUS Alabama: AL is a
//    partial-disclosure state (disclosure not mandated statewide; county
//    practice varies), so buyer-median exports there are unreliable and
//    pricing routes to the ARV-comps path instead.
//
// ── OPEN OPERATOR QUESTION (documented, NOT decided here) ───────────────
// Should Alabama ALSO be in set 1 — i.e., should openers HOLD in AL until a
// verified ARV source is proven, the way they do in TX? Evidence FOR: every
// confirmed portfolio-deed comp contamination case to date has been Alabama
// (35215 ×4, 35206, 43607-adjacent cohort aside); AL's partial-disclosure
// status is plausibly the root cause, not a coincidence. Evidence AGAINST:
// AL/Birmingham is the operator's most productive market — both formal
// offers out this week (501 27th, 213 Meadowdale) are AL — and gating it
// would silence the hottest lane overnight. Adding "AL" to
// NON_DISCLOSURE_STATES below is a ONE-LINE change that must only ever be
// made on an explicit operator ruling. Until then: 35215-class comp caution
// + independent comp pulls before contract stand in as the manual control.

/** The classic legal non-disclosure states — sale prices are NOT public
 *  record. Openers HOLD here (ARV source unprovable) and the frontier
 *  never auto-stages these ZIPs. */
export const NON_DISCLOSURE_STATES: ReadonlySet<string> = new Set([
  "AK", "ID", "KS", "LA", "MS", "MO", "MT", "ND", "NM", "TX", "UT", "WY",
]);

/** States where an InvestorBase buyer-median export cannot be trusted:
 *  the legal 12 plus the partial-disclosure additions (Alabama). Pricing
 *  routes to ARV-comps here instead of the buyer-median path. */
export const BUYER_MEDIAN_UNRELIABLE_STATES: ReadonlySet<string> = new Set([
  ...NON_DISCLOSURE_STATES,
  "AL",
]);

/** The documented, deliberate delta between the two sets. The parity test
 *  pins this so neither list can drift silently again. */
export const PARTIAL_DISCLOSURE_ADDITIONS: ReadonlySet<string> = new Set(["AL"]);
