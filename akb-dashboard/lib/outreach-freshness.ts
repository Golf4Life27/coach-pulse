// Outreach-freshness gate (operator 2026-06-08, item 1).
//
// The stale backlog must not be texted blind. A listing is outreach-eligible
// ONLY if it was re-confirmed ON-MARKET within the freshness window (default
// 48h). The freshness re-verify pass stamps Last_Verified + Live_Status on a
// 1-credit known-URL scrape; this gate reads that stamp.
//
// Pure; the H2/batch selector layers it on top of H2 eligibility so no
// confirmed-stale lead gets a send.

export const DEFAULT_FRESHNESS_HOURS = 48;

export interface FreshnessInput {
  /** ISO timestamp of the last on-market re-verify (Airtable Last_Verified). */
  lastVerified: string | null | undefined;
  /** Live_Status at last verify — must be Active to be outreach-fresh. */
  liveStatus: string | null | undefined;
}

export interface FreshnessVerdict {
  fresh: boolean;
  reason: string | null;
  ageHours: number | null;
}

/** Pure: is this listing confirmed live within the freshness window? */
export function isOutreachFresh(
  input: FreshnessInput,
  now: Date = new Date(),
  maxAgeHours: number = DEFAULT_FRESHNESS_HOURS,
): FreshnessVerdict {
  if (!input.lastVerified) return { fresh: false, reason: "never_verified", ageHours: null };
  const t = Date.parse(input.lastVerified);
  if (!Number.isFinite(t)) return { fresh: false, reason: "last_verified_unparseable", ageHours: null };
  const ageHours = (now.getTime() - t) / 3_600_000;
  if (ageHours < 0) return { fresh: false, reason: "last_verified_in_future", ageHours };
  if (ageHours > maxAgeHours) return { fresh: false, reason: "verify_stale", ageHours };
  const live = (input.liveStatus ?? "").trim().toLowerCase();
  if (live !== "active") return { fresh: false, reason: `live_status_${live || "empty"}`, ageHours };
  return { fresh: true, reason: null, ageHours };
}
