// Price-drop fast lane (operator "get started" 2026-07-11) — pure logic.
// @agent: scout
//
// THE BEST-TIMED OFFER IN THE SYSTEM: the machine knows the exact trigger
// price for every over-ARV listing — the ZIP's renovated value. The moment
// a seller cuts below it, the record flips from cash_no_pencil to
// value-anchored-sendable, and the seller has just signaled motivation.
// Today that record waits for the passive rotation; this lane re-verifies
// it SAME-DAY so the next send slot fires the opener while the cut is hot.
//
// This lane sends NOTHING. It only re-verifies (1-credit known-URL scrape,
// same semantics as freshness-reverify) so the existing send path's own
// freshness gate opens. Selection is pure and evidence-based:
//   - v2 first-touch pool (status empty), Active, has a cached URL
//   - a REAL cut on record (Price_Drop_Count ≥ 1 or Prev_List_Price > list)
//   - the ask now sits BELOW the ZIP's renovated value (seed × sqft)
//   - not already outreach-fresh (a fresh record needs no fast lane)
//
// PURE. No I/O — the route loads seeds and does the verifying.

import type { Listing } from "@/lib/types";
import { SOURCE_VERSION_V2 } from "@/lib/source-version";
import { isActionableMarket } from "@/lib/markets/actionable";
import { isOutreachFresh, DEFAULT_FRESHNESS_HOURS } from "@/lib/outreach-freshness";

export interface FastlaneVerdict {
  due: boolean;
  reason: string | null;
  /** ask headroom under renovated value — ranks the queue. */
  spread: number | null;
}

export function priceDropFastlaneVerdict(
  l: Listing,
  seedArv: number | null,
  now: Date = new Date(),
  maxAgeHours: number = DEFAULT_FRESHNESS_HOURS,
): FastlaneVerdict {
  const skip = (reason: string): FastlaneVerdict => ({ due: false, reason, spread: null });

  if ((l.outreachStatus ?? "").trim() !== "") return skip("not_first_touch_pool");
  if (l.sourceVersion !== SOURCE_VERSION_V2) return skip("not_v2");
  if (l.doNotText === true) return skip("opted_out");
  if ((l.liveStatus ?? "").trim() !== "Active") return skip("not_active");
  if (!l.verificationUrl || l.verificationUrl.trim() === "") return skip("no_cached_url");

  const cutOnRecord =
    (l.priceDropCount ?? 0) >= 1 ||
    (l.prevListPrice != null && l.listPrice != null && l.listPrice < l.prevListPrice);
  if (!cutOnRecord) return skip("no_price_cut_evidence");

  if (seedArv == null || l.listPrice == null) return skip("no_value_basis");
  if (l.listPrice >= seedArv) return skip("still_over_renovated_value");

  const market = isActionableMarket({ state: l.state, city: l.city, zip: l.zip });
  if (!market.actionable) return skip(market.reason ?? "market_not_actionable");

  // Already fresh → the send slots see it already; no credit needed.
  if (isOutreachFresh({ lastVerified: l.lastVerified, liveStatus: l.liveStatus }, now, maxAgeHours).fresh) {
    return skip("already_fresh");
  }

  return { due: true, reason: null, spread: seedArv - l.listPrice };
}

/** Pure: rank due targets — biggest headroom under renovated value first
 *  (the deepest newly-penciling cuts are the hottest sends). */
export function rankFastlaneTargets<T extends { spread: number | null }>(targets: T[]): T[] {
  return [...targets].sort((a, b) => (b.spread ?? 0) - (a.spread ?? 0));
}
