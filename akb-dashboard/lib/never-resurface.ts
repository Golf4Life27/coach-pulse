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
