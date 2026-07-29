// Never-resurface blocklist — addresses walked permanently (e.g. Highland
// 4/30/2026). Canonical home for the set + matcher; verify-listing auto-
// rejects on match, and the stale-outreach cleanup excludes/flags them.
//
// Keys are lowercased, punctuation-light street addresses. Match via
// isNeverResurface() so callers share one normalization rule.

export const NEVER_RESURFACE: ReadonlySet<string> = new Set([
  "2715 monterey st", "714 hallie ave", "4330 pensacola ct",
  "9618 tamalpais dr", "811 manhattan dr", "1635 arbor pl",
  "4448 marcell ave", "2725 bowling green ave", "2011 ramsey ave",
  "707 n pine st", "8641 craige dr", "910 green st",
  // 2026-06-05 — corporate-investor seller (recorded fact: "Albert from
  // Mainstay, corporate investor at/near list"). Same precedent as
  // 910 Green St. Not a guess from free text; a recorded reply.
  "336 burwood dr",
  // 2026-07-28 — operator kills, promoted from record-notes prose to this
  // machine-enforced list after the 533 Robison digest error (a kill that
  // lived only in Notes/Spine got re-ranked as the hottest deal by narrative
  // drift; the send gate now refuses this list for EVERY purpose). Robison:
  // structural collapse, DO NOT PAPER, operator walk. West Ave: accepted
  // $110,499 failed property-level reality, killed pre-paper. Joffre:
  // unbridgeable $100K gap, operator kill. (963 W 3rd joins after its
  // operator-approved courtesy exit resolves.)
  "533 robison dr",
  "1122 west ave sw",
  "2048 joffre ave",
  // 2026-07-29 — first kill under the CONDITION-KILL DELEGATION (operator:
  // "I don't need to give you permission to kill evidence-based
  // rehab/condition riddled properties"). Stanwood: agent-provided document
  // package proved bowing basement walls (right + back, never repaired),
  // mostly-knob-and-tube wiring, and a $17,645/14-month maintenance ledger
  // (~$1,260/mo against $1,450 rent). Realistic MAO ~$25-30K vs $119,900
  // ask. Evidence-based, spine-logged (recpoqbjTOl2icxwI).
  "1848 stanwood rd",
]);

/** Pure: true when an address is on the never-resurface blocklist. */
export function isNeverResurface(address: string | null | undefined): boolean {
  if (!address) return false;
  return NEVER_RESURFACE.has(address.trim().toLowerCase());
}

/**
 * Loose matcher — true if any blocklisted street fragment is a substring
 * of the address (lowercased, trimmed). Built for the Pipeline_State
 * backfill hard-guard (decision rechGJ32oW9Qmv8wp): the strict matcher
 * above requires exact equality, which misses against the full-form
 * addresses stored in Listings_V1 (e.g. `"2715 Monterey St, San Antonio,
 * TX 78201"` vs the blocklist entry `"2715 monterey st"`).
 *
 * False-positive risk is bounded: every blocklist entry includes a
 * house number + street name + suffix (e.g. `"707 n pine st"`), so
 * accidental substring collisions across the live address space are
 * effectively zero. If a new entry ever lacks a house number, drop it
 * — this matcher must stay safe by construction.
 *
 * Returns true on ANY match for any entry. Order-insensitive.
 */
export function isNeverResurfaceLoose(
  address: string | null | undefined,
): boolean {
  if (!address) return false;
  const haystack = address.trim().toLowerCase();
  if (!haystack) return false;
  for (const needle of NEVER_RESURFACE) {
    if (haystack === needle) return true;
    if (haystack.includes(needle)) return true;
  }
  return false;
}
