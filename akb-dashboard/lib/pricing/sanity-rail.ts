// Median sanity rail (adjudication recXJrM7EYK3pEFmF item 6). @agent: appraiser
//
// One of the ZIP median's three surviving roles: CROSS-CHECK the
// property-up number, never set or gate it. delta ≥ 25% flags for
// operator review (the same threshold as the INV-005 rehab-vision drift
// banner — one drift vocabulary). NEVER gates a send.

export const SANITY_RAIL_FLAG_PCT = 0.25;

export interface SanityRailResult {
  /** |property_up − zip_median| / zip_median, or null when either input
   *  is missing — an absent rail is shown as absent, never fabricated. */
  deltaPct: number | null;
  flagged: boolean;
  description: string | null;
}

export function computeSanityRail(
  propertyUpMao: number | null | undefined,
  zipMedian: number | null | undefined,
): SanityRailResult {
  const p = typeof propertyUpMao === "number" && Number.isFinite(propertyUpMao) && propertyUpMao > 0 ? propertyUpMao : null;
  const m = typeof zipMedian === "number" && Number.isFinite(zipMedian) && zipMedian > 0 ? zipMedian : null;
  if (p == null || m == null) {
    return { deltaPct: null, flagged: false, description: null };
  }
  const deltaPct = Math.abs(p - m) / m;
  const flagged = deltaPct >= SANITY_RAIL_FLAG_PCT;
  return {
    deltaPct,
    flagged,
    description: flagged
      ? `Property-up $${p.toLocaleString()} differs from ZIP median $${m.toLocaleString()} by ${(deltaPct * 100).toFixed(0)}% (≥${SANITY_RAIL_FLAG_PCT * 100}% — review the inputs; the rail informs, it never gates)`
      : `Within ${(deltaPct * 100).toFixed(0)}% of ZIP median $${m.toLocaleString()}`,
  };
}
