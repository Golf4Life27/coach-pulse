// Vendor-agnostic intake filter (Ship 2 — ATTOM auto-intake, reusable).
// @agent: scout
//
// Pure. Operates on a normalized IntakeCandidate so it's reusable across
// any source (ATTOM today; PropStream/MLS/manual later). The source
// adapter (e.g. lib/crawler/sources/attom.ts) maps vendor JSON → this
// shape; the filter never sees vendor-specific fields.
//
// Established intake rules (locked 2026-05-25):
//   - propertyType = SFR (single-family residential)
//   - beds >= 2
//   - $75,000 <= listPrice <= $400,000
//   - listedDate within last 90 days
//   - distress signal present
//   - State NOT IN {IL, MO, SC, NC, OK, ND} (wholesale-restrictive)

export const EXCLUDED_STATES: ReadonlySet<string> = new Set([
  "IL", "MO", "SC", "NC", "OK", "ND",
]);

export const INTAKE_RULES = {
  minBeds: 2,
  minListPrice: 75_000,
  maxListPrice: 400_000,
  maxListedAgeDays: 90,
} as const;

export interface IntakeCandidate {
  /** Vendor-stable id for trace/dedup (e.g. ATTOM attomId). */
  sourceId: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** Raw vendor property-type string (normalized internally). */
  propertyType: string | null;
  beds: number | null;
  listPrice: number | null;
  /** ISO date the listing went active. */
  listedDate: string | null;
  /** Adapter-derived: any distress signal present (pre-foreclosure,
   *  tax lien, vacant, high equity + long tenure, etc.). */
  hasDistressSignal: boolean;
}

export type IntakeRejectReason =
  | "not_sfr"
  | "beds_below_min"
  | "list_price_out_of_band"
  | "list_price_missing"
  | "listed_date_missing"
  | "listed_date_too_old"
  | "no_distress_signal"
  | "excluded_state"
  | "state_missing";

export interface IntakeEvaluation {
  accept: boolean;
  reasons: IntakeRejectReason[];
}

const DAY_MS = 86_400_000;

/** Pure: SFR detection across common vendor spellings. */
export function isSingleFamily(propertyType: string | null): boolean {
  if (!propertyType) return false;
  const t = propertyType.toLowerCase();
  // Accept SFR / single family / detached; reject condo/townhouse/multi/land.
  if (/condo|townhouse|town home|townhome|multi|duplex|triplex|fourplex|apartment|commercial|land|lot|mobile|manufactured/.test(t)) {
    return false;
  }
  return /sfr|single\s*family|single-family|residential \(nec\)|detached/.test(t);
}

/** Pure: evaluate one candidate against all intake rules. Collects ALL
 *  failing reasons (not short-circuit) so rejections are fully itemized. */
export function evaluateIntakeCandidate(
  c: IntakeCandidate,
  now: Date = new Date(),
): IntakeEvaluation {
  const reasons: IntakeRejectReason[] = [];

  if (!isSingleFamily(c.propertyType)) reasons.push("not_sfr");

  if (c.beds == null || c.beds < INTAKE_RULES.minBeds) reasons.push("beds_below_min");

  if (c.listPrice == null) {
    reasons.push("list_price_missing");
  } else if (c.listPrice < INTAKE_RULES.minListPrice || c.listPrice > INTAKE_RULES.maxListPrice) {
    reasons.push("list_price_out_of_band");
  }

  if (!c.listedDate) {
    reasons.push("listed_date_missing");
  } else {
    const t = Date.parse(c.listedDate);
    if (Number.isNaN(t)) {
      reasons.push("listed_date_missing");
    } else if ((now.getTime() - t) / DAY_MS > INTAKE_RULES.maxListedAgeDays) {
      reasons.push("listed_date_too_old");
    }
  }

  if (!c.hasDistressSignal) reasons.push("no_distress_signal");

  if (!c.state) {
    reasons.push("state_missing");
  } else if (EXCLUDED_STATES.has(c.state.trim().toUpperCase())) {
    reasons.push("excluded_state");
  }

  return { accept: reasons.length === 0, reasons };
}

export interface IntakeFilterResult {
  accepted: IntakeCandidate[];
  rejected: Array<{ candidate: IntakeCandidate; reasons: IntakeRejectReason[] }>;
}

/** Pure: partition a candidate list into accepted / rejected-with-reasons. */
export function filterIntakeCandidates(
  candidates: IntakeCandidate[],
  now: Date = new Date(),
): IntakeFilterResult {
  const accepted: IntakeCandidate[] = [];
  const rejected: IntakeFilterResult["rejected"] = [];
  for (const c of candidates) {
    const ev = evaluateIntakeCandidate(c, now);
    if (ev.accept) accepted.push(c);
    else rejected.push({ candidate: c, reasons: ev.reasons });
  }
  return { accepted, rejected };
}

/** Pure: normalize an address for dedup comparison against existing
 *  Listings_V1 rows. Lowercase, collapse whitespace, strip punctuation. */
export function normalizeAddressKey(address: string | null): string {
  if (!address) return "";
  return address.toLowerCase().replace(/[.,#]/g, "").replace(/\s+/g, " ").trim();
}
