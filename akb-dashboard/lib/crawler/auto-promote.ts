// Crawler auto-promote decision (INV-CRAWLER-AGENT-ENRICHMENT). @agent: scout
//
// A crawler-accepted listing is "auto-promote eligible" when it can go
// straight to H2-textable state instead of the manual Review queue. PURE —
// no env reads, no I/O. The route layers the feature flags
// (CRAWLER_AUTO_PROMOTE_LIVE / _DRY_RUN) on top of this intrinsic decision,
// so dry-run reporting can show what WOULD promote without writing it.
//
// Eligibility (ALL required):
//   1. Firecrawl classified the listing "accept" — still-active, non-wholesaler,
//      with at least one distress signal (condition copy OR DOM ≥ threshold OR
//      a price reduction). A distress signal overrides a renovation match.
//      Listings with no distress signal land in the soft Review queue, or are
//      rejected outright if renovated — either way accepted=false here.
//   2. List_Price > 0 (so MAO_V1 computes).
//   3. State NOT wholesale-restricted (IL/MO/SC/NC/OK/ND). In practice the
//      intake filter already rejects these pre-Firecrawl, so this is
//      defense-in-depth and normally contributes 0.
//   4. Agent_Phone normalizes to a US E.164 number — H2 cannot text without it.
//
// Returns the FIRST failing reason (itemized), or { promote: true }.

import { EXCLUDED_STATES } from "@/lib/crawler/intake-filter";
import { normalizePhone } from "@/lib/phone-normalize";

export type AutoPromoteBlockReason =
  | "not_accepted"
  | "list_price_missing"
  | "wholesale_restricted_state"
  | "no_agent_phone"
  | "mao_not_underwritten";

export interface AutoPromoteInput {
  /** classifyVerifiedListing outcome === "accept". */
  accepted: boolean;
  agentPhone: string | null;
  state: string | null;
  listPrice: number | null;
  /** Track-aware Your_MAO underwritten BEFORE promote (operator 2026-06-09).
   *  A lead must NEVER be outreach-eligible without a computed MAO on it —
   *  the new belt order is intake → enrich → verify → underwrite → promote
   *  → outreach. null/undefined here blocks promote with mao_not_underwritten. */
  underwrittenMao?: number | null;
}

export interface AutoPromoteDecision {
  promote: boolean;
  reason: AutoPromoteBlockReason | null;
}

export function shouldAutoPromote(i: AutoPromoteInput): AutoPromoteDecision {
  if (!i.accepted) return { promote: false, reason: "not_accepted" };
  if (i.listPrice == null || i.listPrice <= 0)
    return { promote: false, reason: "list_price_missing" };
  if (i.state && EXCLUDED_STATES.has(i.state.trim().toUpperCase()))
    return { promote: false, reason: "wholesale_restricted_state" };
  if (!normalizePhone(i.agentPhone))
    return { promote: false, reason: "no_agent_phone" };
  if (i.underwrittenMao == null || !Number.isFinite(i.underwrittenMao) || i.underwrittenMao <= 0)
    return { promote: false, reason: "mao_not_underwritten" };
  return { promote: true, reason: null };
}
