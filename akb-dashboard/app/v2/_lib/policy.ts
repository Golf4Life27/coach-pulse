// QUEUE HYGIENE (operator review 6/10, ruling 5): terminal-state records and
// paused-market items are not decisions — the spine already decided. They
// leave the main queue with a reference to the standing decision, and the
// open-decision count reflects forward-only reality.
//
// Paused markets are hardcoded here with their provenance until ops ships a
// machine-readable standing-policy read (backend request #7) — the source of
// truth is the spine, this is a cached projection of it.

import type { ListingDetail, OperatorItem } from "./types";

export const PAUSED_MARKETS: Array<{ state: string; label: string; reference: string }> = [
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
  const paused = PAUSED_MARKETS.find((m) => m.state === (l.state ?? "").toUpperCase());
  if (paused) return { suppressed: true, reference: paused.reference };
  return { suppressed: false, reference: null };
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

/** Live-first ordering: anything with activity today floats above the rest;
 *  within a band, priority then recency. */
export function sortActionable(items: OperatorItem[]): OperatorItem[] {
  const today = new Date().toISOString().slice(0, 10);
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return [...items].sort((a, b) => {
    const aToday = (a.createdAt ?? "").startsWith(today) ? 0 : 1;
    const bToday = (b.createdAt ?? "").startsWith(today) ? 0 : 1;
    if (aToday !== bToday) return aToday - bToday;
    const r = (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
    if (r !== 0) return r;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
}
