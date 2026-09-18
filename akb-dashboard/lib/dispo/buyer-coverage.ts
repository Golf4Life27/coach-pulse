// BUYER-COVERAGE GATE — surfaces a HOLD before anyone signs a contract in a
// metro with no funded buyers (operator ruling 2026-09-18, Spine
// recnmCDflZ43MEsDp): "we sign contracts before we have buyers." The Buyers
// table has 79 rows, 5 with a price box, 1 with proof of funds — thin enough
// that this has to be visible on the SAME feed the operator already reads,
// not a report nobody opens.
//
// PURE. Reads a ShortlistResult (already computed by buildBuyerShortlist)
// and reports how covered the deal actually is. Never sends, never writes.

import type { ShortlistResult } from "@/lib/dispo/buyer-shortlist";
import type { ConveyorItem } from "@/lib/conveyor/model";

export type CoverageLevel = "none" | "thin" | "ok";

export interface BuyerCoverage {
  level: CoverageLevel;
  geoBuyers: number;
  fundedBuyers: number;
  emailable: number;
  reason: string;
}

/** Geo evidence strong enough to count as "a buyer for this metro" — matches
 *  a ZIP (confirmed or operator-flagged unconfirmed) or at least the state.
 *  "no_match" (screened out by their own stated box) and "none" (unscreened,
 *  no geography at all) do not count — see buyer-shortlist's GeoEvidence
 *  posture note. */
const GEO_COUNTS: ReadonlySet<string> = new Set(["zip_confirmed", "zip_unconfirmed", "state"]);

function areaLabel(subject: ShortlistResult["subject"]): string {
  if (subject.zip) return subject.zip;
  if (subject.city && subject.state) return `${subject.city}, ${subject.state}`;
  return subject.state ?? subject.city ?? "this deal";
}

/** Pure. Reports how many buyers on the ranked list are actually in the
 *  deal's area, and how many of those are funded and reachable. */
export function assessBuyerCoverage(shortlist: ShortlistResult): BuyerCoverage {
  const geoRows = shortlist.ranked.filter((b) => GEO_COUNTS.has(b.geo));
  const geoBuyers = geoRows.length;
  const fundedBuyers = geoRows.filter((b) => b.pofUsable).length;
  const emailable = geoRows.filter((b) => !!b.email).length;

  if (geoBuyers === 0) {
    return {
      level: "none",
      geoBuyers,
      fundedBuyers,
      emailable,
      reason: `No buyers on file for ${areaLabel(shortlist.subject)}.`,
    };
  }

  if (fundedBuyers === 0) {
    return {
      level: "thin",
      geoBuyers,
      fundedBuyers,
      emailable,
      reason: `${geoBuyers} buyer${geoBuyers === 1 ? "" : "s"} in the area, none with proof of funds on file.`,
    };
  }

  return {
    level: "ok",
    geoBuyers,
    fundedBuyers,
    emailable,
    reason: `${fundedBuyers} funded buyer${fundedBuyers === 1 ? "" : "s"} in the area.`,
  };
}

const HOUR_MS = 3_600_000;

/** The single HOLD card for one deal, as a ConveyorItem — null when coverage
 *  is "ok" (nothing to surface). Rides the same conveyor contract-lifecycle
 *  items use so it merges into the one ranked feed. */
export function buyerCoverageItem(input: {
  recordId: string;
  address: string | null;
  city: string | null;
  state: string | null;
  coverage: BuyerCoverage;
  nowIso: string;
}): ConveyorItem | null {
  const { recordId, address, city, state, coverage, nowIso } = input;
  if (coverage.level === "ok") return null;

  const nowMs = Date.parse(nowIso);
  const deadlineAt = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 24 * HOUR_MS).toISOString();
  const where = city && state ? `${city}, ${state}` : state ?? city ?? address ?? recordId;
  const href = `/pipeline/${recordId}`;

  return {
    key: `buyer_coverage:${recordId}`,
    source: "contract",
    type: "2C",
    title: `HOLD: no funded buyers in ${where} - do not sign until dispo has a buyer`,
    reasoning: `${coverage.reason} Grow the list or price to a buyer that exists before EMD goes hard.`,
    recordId,
    href,
    dollars: null,
    deadlineAt,
    deadlineImplied: true,
    postedAt: nowIso,
    verbatim: null,
    actions: [{ kind: "open", href, label: "See buyers" }],
  };
}
