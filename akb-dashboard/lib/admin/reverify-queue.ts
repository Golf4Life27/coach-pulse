// H2 Auto-Proceed queue re-verification — pure planning logic.
// @agent: scout / crier
//
// Sibling to the renovation-hard-veto amendment (commit 66d82a3) and the
// deploy-truth work (Spine recwkHvBMTjeMLECp). The Auto-Proceed queue was
// classified BEFORE the current classifyVerifiedListing precedence shipped
// (infra→inactive→new_construction→wholesaler→renovation→distress→review),
// so it needs a re-pass before the first live H2 fire.
//
// PURE. Maps a classifyVerifiedListing outcome to a requalification ACTION.
// The route (app/api/admin/reverify-queue) does the I/O: read eligible set,
// Firecrawl verify, then apply these actions as Airtable writes.
//
// SAFETY INVARIANT: a Firecrawl *infrastructure* failure (no creds, rate
// limit, transport error, unresolved URL) must NEVER demote a listing — it
// is not a listing-quality signal. Those map to `skip_unverified` (no
// write). Only genuine content verdicts (renovated/turnkey/new-construction
// → Review; inactive → Off Market) demote.

import type { VerifiedOutcome } from "@/lib/crawler/sources/firecrawl";

export type RequalAction =
  | { action: "keep"; reason: "clean_distress" }
  | { action: "demote_review"; reason: string }
  | { action: "demote_dead"; reason: string }
  | { action: "skip_unverified"; reason: string };

// Firecrawl reasons that are INFRA failures, not listing verdicts — never
// demote on these.
const INFRA_REASONS = new Set([
  "firecrawl_not_configured",
  "firecrawl_rate_limited",
  "firecrawl_error",
  "firecrawl_url_unresolved",
]);

/**
 * Pure: map a classifyVerifiedListing outcome to a queue requalification
 * action.
 *   accept                              → keep (stays Auto-Proceed)
 *   review (condition_signal_missing)   → demote_review
 *   reject: inactive                    → demote_dead (Off Market)
 *   reject: renovated/new_construction/
 *           wholesaler                  → demote_review (human decides)
 *   reject: infra failure               → skip_unverified (NO write)
 */
export function planRequalification(outcome: VerifiedOutcome): RequalAction {
  if (outcome.outcome === "accept") {
    return { action: "keep", reason: "clean_distress" };
  }
  if (outcome.outcome === "review") {
    return { action: "demote_review", reason: outcome.reason };
  }
  // outcome.outcome === "reject"
  const reason = outcome.reason;
  if (INFRA_REASONS.has(reason)) {
    return { action: "skip_unverified", reason };
  }
  if (reason === "firecrawl_inactive") {
    return { action: "demote_dead", reason };
  }
  // renovated / new_construction_excluded / wholesaler_excluded (+ any
  // future content reject) → human Review, never silent-kill.
  return { action: "demote_review", reason };
}

/** The Airtable field write for a demotion action. `keep` / `skip_unverified`
 *  return null (no write). Field NAMES (patchListingsBatch maps to IDs).
 *  Verification_Notes is composed by the caller (needs prior notes to append). */
export function requalWriteFields(action: RequalAction): Record<string, unknown> | null {
  if (action.action === "demote_review") return { Outreach_Status: "Review" };
  if (action.action === "demote_dead") return { Live_Status: "Off Market" };
  return null; // keep / skip_unverified — no write
}

/** Provenance line appended to Verification_Notes on a demotion. */
export function buildRequalNote(existing: string | null, isoDate: string, action: RequalAction): string {
  const verb =
    action.action === "demote_review" ? "→ Review" : action.action === "demote_dead" ? "→ Off Market (inactive)" : "(no change)";
  const line = `[${isoDate}] H2 queue re-verify (Spine recwkHvBMTjeMLECp): ${verb} — classify reason: ${action.reason}.`;
  return existing && existing.trim() ? `${existing}\n\n${line}` : line;
}
