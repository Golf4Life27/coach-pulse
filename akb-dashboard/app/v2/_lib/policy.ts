// QUEUE HYGIENE + QUEUE ORDER (rulings 6/10 + round-2): terminal-state
// records and paused-market items are not decisions — the spine already
// decided. They leave the main queue with a reference to the standing
// decision, and the open-decision count reflects forward-only reality.
// This module is also the single home for queue importance ordering.
//
// Paused markets are hardcoded here with their provenance until ops ships a
// machine-readable standing-policy read (backend request #7a) — the source of
// truth is the spine, this is a cached projection of it. All consumers go
// through marketSuppression() so the swap to the live read is one function.

import type { ListingDetail, OperatorItem, QueueCard } from "./types";
import { isLocalToday } from "./format";

const PAUSED_MARKETS: Array<{ state: string; label: string; reference: string }> = [
  {
    state: "TN",
    label: "Memphis",
    reference: "Memphis market paused — standing spine decision (stale-pipeline triage, June 2026)",
  },
];

export interface SuppressionVerdict {
  suppressed: boolean;
  /** Plain-English reference to the standing decision. */
  reference: string | null;
}

/** The single swap point for backend request #7a (standing-policy read). */
export function marketSuppression(state: string | null | undefined): SuppressionVerdict {
  const paused = PAUSED_MARKETS.find((m) => m.state === (state ?? "").toUpperCase());
  return paused
    ? { suppressed: true, reference: paused.reference }
    : { suppressed: false, reference: null };
}

export function listingSuppression(l: ListingDetail | undefined | null): SuppressionVerdict {
  if (!l) return { suppressed: false, reference: null };
  const stage = (l.pipelineStage ?? "").toLowerCase();
  const status = (l.outreachStatus ?? "").toLowerCase();
  if (stage === "dead" || status === "dead") {
    return { suppressed: true, reference: "record is marked DEAD — already decided" };
  }
  if (l.doNotText) {
    return { suppressed: true, reference: "record is DO NOT TEXT — standing decision" };
  }
  return marketSuppression(l.state);
}

export interface ClassifiedOperatorItems {
  actionable: OperatorItem[];
  suppressed: Array<{ item: OperatorItem; reference: string }>;
}

export function classifyOperatorItems(
  items: OperatorItem[],
  listingsById: Map<string, ListingDetail>,
): ClassifiedOperatorItems {
  const actionable: OperatorItem[] = [];
  const suppressed: Array<{ item: OperatorItem; reference: string }> = [];
  for (const item of items) {
    if (item.status === "resolved") continue;
    const listing = item.sourceRecordId ? listingsById.get(item.sourceRecordId) : null;
    const v = listingSuppression(listing);
    if (v.suppressed) suppressed.push({ item, reference: v.reference! });
    else actionable.push(item);
  }
  return { actionable, suppressed };
}

// ── Merged queue ordering (round-2 rule 2): today's live items pinned,
// then importance — ACT NOW (agent replies) > HIGH (deals in flight +
// high-priority items) > MEDIUM (checklist gaps) > LOW (cold sweeps) —
// then recency. One source of truth for the board's order. ──────────────

export type QueueEntry =
  | { type: "item"; item: OperatorItem; liveToday: boolean; rank: number; recency: string }
  | { type: "card"; card: QueueCard; liveToday: boolean; rank: number; recency: string };

const ITEM_RANK: Record<string, number> = { high: 1, medium: 2, low: 3 };
const CARD_RANK: Record<string, number> = { response: 0, deal: 1, dd: 2, stale: 3 };

export function mergeAndSort(
  items: OperatorItem[],
  cards: QueueCard[],
  listingsById: Map<string, ListingDetail>,
): QueueEntry[] {
  const entries: QueueEntry[] = [];

  for (const item of items) {
    entries.push({
      type: "item",
      item,
      liveToday: isLocalToday(item.createdAt),
      rank: ITEM_RANK[item.priority] ?? 2,
      recency: item.createdAt ?? "",
    });
  }
  for (const card of cards) {
    const listing = card.table === "listings" ? listingsById.get(card.recordId) : undefined;
    let lastTouch = card.lastOutreachDate ?? "";
    for (const t of [listing?.lastInboundAt, listing?.lastOutboundAt]) {
      if (t && t > lastTouch) lastTouch = t;
    }
    entries.push({
      type: "card",
      card,
      liveToday: isLocalToday(listing?.lastInboundAt),
      rank: CARD_RANK[card.kind] ?? 2,
      recency: lastTouch,
    });
  }

  return entries.sort(
    (a, b) =>
      Number(b.liveToday) - Number(a.liveToday) ||
      a.rank - b.rank ||
      b.recency.localeCompare(a.recency),
  );
}
