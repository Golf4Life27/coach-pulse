// Stale Auto-Proceed outreach cleanup (pre-H2-live mass reset).
// @agent: sentry
//
// Pure selector + note builder for the one-time cleanup of the
// Auto-Proceed backlog (Outreach_Status empty + Execution_Path
// "Auto Proceed" + Live_Status "Active" + Agent_Phone present + not
// already Do_Not_Text). The route patches Do_Not_Text=true and appends
// a provenance note; if a property is still active it re-enters via
// Crawler 1.0 with the current intake filter + better math.
//
// Two integrity checks the route surfaces from this module:
//   - restricted-state violations: an eligible record in a wholesale-
//     restricted state should NOT exist (Auto Proceed implies it cleared
//     state filtering) — count >0 is a P1 data bug, not a cleanup target.
//   - never-resurface matches: addresses on the permanent walk list are
//     EXCLUDED from the write set; any that surface here were never set
//     Do_Not_Text and are flagged as an integrity gap.

import type { Listing } from "@/lib/types";
import { EXCLUDED_STATES } from "@/lib/crawler/intake-filter";
import { isNeverResurface } from "@/lib/never-resurface";

export const AUTO_PROCEED = "Auto Proceed";
export const LIVE_ACTIVE = "Active";

/** Sentinel substring that marks a record already cleaned by this op —
 *  guards re-append on a partial-run retry (the Do_Not_Text filter already
 *  excludes fully-processed records, this covers note-without-flag gaps). */
export const CLEANUP_SENTINEL = "Pre-H2-live mass cleanup";

/** Pure: append the cleanup provenance note. Returns the prior notes
 *  unchanged when the sentinel is already present (idempotent). */
export function buildCleanupNote(existing: string | null, today: string): string {
  const prior = existing ?? "";
  if (prior.includes(CLEANUP_SENTINEL)) return prior;
  const line = `${today} — ${CLEANUP_SENTINEL}. Reset to Do_Not_Text. Will re-enter pipeline via Crawler if still active with current intake filters.`;
  return prior ? `${prior}\n\n${line}` : line;
}

function outreachStatusEmpty(l: Listing): boolean {
  return !l.outreachStatus || l.outreachStatus.trim() === "";
}

function agentPhonePresent(l: Listing): boolean {
  return !!l.agentPhone && l.agentPhone.trim() !== "";
}

/** Pure: does a listing match the base cleanup criteria (before the
 *  never-resurface exclusion / restricted-state integrity split)? */
export function matchesCleanupCriteria(l: Listing): boolean {
  return (
    outreachStatusEmpty(l) &&
    l.executionPath === AUTO_PROCEED &&
    l.liveStatus === LIVE_ACTIVE &&
    agentPhonePresent(l) &&
    l.doNotText !== true
  );
}

export interface StaleOutreachSelection {
  /** Records to patch Do_Not_Text=true (never-resurface excluded). */
  eligible: Listing[];
  /** Never-resurface addresses that matched the criteria — EXCLUDED from
   *  the write set and flagged (they should already be Do_Not_Text). */
  excludedNeverResurface: Listing[];
  /** Eligible records sitting in a wholesale-restricted state — a P1 data
   *  integrity flag (expected count: 0). Still written (Do_Not_Text is
   *  correct for them too); surfaced separately for investigation. */
  restrictedStateViolations: Listing[];
}

function inRestrictedState(l: Listing): boolean {
  return !!l.state && EXCLUDED_STATES.has(l.state.trim().toUpperCase());
}

/** Pure: partition the listing set into the cleanup write list + the two
 *  integrity-flag buckets. */
export function selectStaleOutreach(listings: Listing[]): StaleOutreachSelection {
  const eligible: Listing[] = [];
  const excludedNeverResurface: Listing[] = [];
  const restrictedStateViolations: Listing[] = [];

  for (const l of listings) {
    if (!matchesCleanupCriteria(l)) continue;
    if (isNeverResurface(l.address)) {
      excludedNeverResurface.push(l);
      continue;
    }
    eligible.push(l);
    if (inRestrictedState(l)) restrictedStateViolations.push(l);
  }

  return { eligible, excludedNeverResurface, restrictedStateViolations };
}

/** Pure: compact sample row for the dry-run response (address + agent +
 *  DOM + zip per the brief). */
export function toSampleRow(l: Listing): {
  recordId: string;
  address: string;
  agent: string | null;
  dom: number | null;
  zip: string | null;
} {
  return {
    recordId: l.id,
    address: l.address,
    agent: l.agentName,
    dom: l.dom,
    zip: l.zip,
  };
}
