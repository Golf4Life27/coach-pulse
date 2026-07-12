// Live Deals — the operator's active money, made visible (operator
// 2026-07-12: "the common sense thing that gives me the best and most
// accurate tools and data to make money"). @agent: maverick
//
// THE GAP THIS CLOSES: the decision conveyor is proposal-driven, and the
// 🎯 counter is a month-to-date pace number. Neither SHOWS the operator his
// live pipeline. An email-worked legacy deal heading to contract (the 3123
// Sunbeam class — a v1_legacy record revived by hand) counts in the number
// but appears on NO surface. This module enumerates every record currently
// in a negotiation status — REGARDLESS of source version — because an active
// negotiation is current-era activity by definition. The forward ruling
// governs top-of-funnel discovery; it must never hide live money.
//
// PURE. No I/O — the route supplies rows; the component supplies motion.
// Sourced numbers only: a dollar figure renders only when its field is set.

import { NEGOTIATION_STATUSES } from "@/lib/maverick/heartbeat";

/** Canonical status list for the route's filterByFormula. */
export const NEGOTIATION_STATUS_LIST: readonly string[] = [...NEGOTIATION_STATUSES];

export interface LiveDealRow {
  id: string;
  address: string | null;
  status: string | null;
  /** Contract_Offer_Price (the live negotiated number) if set, else the
   *  Outreach_Offer_Price door-opener. */
  contractPrice: number | null;
  listPrice: number | null;
  /** Underwritten_MAO (or property MAO) — the doctrine ceiling. */
  ceiling: number | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  sourceVersion: string | null;
}

export interface RankedLiveDeal {
  id: string;
  /** Street line only — the deal room carries the full address. */
  street: string;
  status: string;
  contractPrice: number | null;
  listPrice: number | null;
  ceiling: number | null;
  /** ceiling − contractPrice when both are present (negative = over ceiling). */
  headroom: number | null;
  /** Ball in our court: they replied more recently than we did (or we have
   *  never replied). This is the actionable set. */
  needsYou: boolean;
  /** max(lastInboundAt, lastOutboundAt) — drives recency ordering. */
  lastActivityAt: string | null;
  /** True for pre-v2 records — surfaced as a quiet "legacy" tag, never hidden. */
  legacy: boolean;
  href: string;
}

const SOURCE_VERSION_V2 = "v2_post_2026-05-26";

function street(address: string | null): string {
  return (address ?? "").split(",")[0].trim() || "(address pending)";
}

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/** Ball-in-our-court: an inbound with no later outbound answer. */
export function ballInOurCourt(lastInboundAt: string | null, lastOutboundAt: string | null): boolean {
  if (!lastInboundAt) return false;
  const inbound = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(inbound)) return false;
  if (!lastOutboundAt) return true;
  const outbound = new Date(lastOutboundAt).getTime();
  if (!Number.isFinite(outbound)) return true;
  return inbound > outbound;
}

/** Pure: shape + rank the live-deal set. Ordering:
 *   1. ball in your court first (needs a reply),
 *   2. then most-recent activity (newest first),
 *   3. id as a stable final tiebreak.
 *  Every negotiation-status record is included, any era — that is the point. */
export function rankLiveDeals(rows: LiveDealRow[]): RankedLiveDeal[] {
  const deals: RankedLiveDeal[] = rows
    .filter((r) => NEGOTIATION_STATUSES.has(r.status ?? ""))
    .map((r) => {
      const headroom =
        r.ceiling != null && r.contractPrice != null ? r.ceiling - r.contractPrice : null;
      return {
        id: r.id,
        street: street(r.address),
        status: r.status as string,
        contractPrice: r.contractPrice,
        listPrice: r.listPrice,
        ceiling: r.ceiling,
        headroom,
        needsYou: ballInOurCourt(r.lastInboundAt, r.lastOutboundAt),
        lastActivityAt: laterIso(r.lastInboundAt, r.lastOutboundAt),
        legacy: (r.sourceVersion ?? "") !== SOURCE_VERSION_V2,
        href: `/pipeline/${r.id}`,
      };
    });

  return deals.sort((a, b) => {
    if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
    const at = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
    const bt = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
    if (bt !== at) return bt - at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Count of deals where the ball is in the operator's court — the header badge. */
export function needsYouCount(deals: RankedLiveDeal[]): number {
  return deals.reduce((n, d) => n + (d.needsYou ? 1 : 0), 0);
}
