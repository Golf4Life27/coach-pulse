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
