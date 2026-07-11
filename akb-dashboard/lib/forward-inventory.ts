// Forward-only measurement filter (#38 — THE FORWARD RULING, spine
// rec8wKrqajIXYQXbq, operator 2026-07-10 Type 2C).
//
// "Every pool, gauge, count, and alert (supply floor, verify_stale, queue
// depth, briefings) must be computed over current-doctrine (v2+) inventory
// from the same fresh fetch the send path uses — the phantom-43 class
// (telemetry counting ghost/legacy/stale-cache rows) is a bug wherever it
// appears."
//
// This is the ONE place that rule is encoded. Every MEASUREMENT surface
// (Pulse detectors, brief pools, gauge counts) filters through here so the
// numbers the operator sees describe the inventory the machine actually
// works.
//
// What does NOT filter through here — deliberately:
//   - Reconcile/sync paths (quo-sync, gmail-sync, quo-reconcile, webhook
//     match pools): inbound on ANY thread must be captured — "a LIVE seller
//     replying on an old thread remains fair game; inbound revives a
//     thread" (same ruling). Filtering those would drop real replies.
//   - Dedup / prior-contact indexes: they exist to see everything.
//   - The sentinel reply queue: it surfaces owed replies, which includes
//     revived legacy threads by design.

import { SOURCE_VERSION_V2 } from "@/lib/source-version";

/** Pure: current-era (v2+) rows only. The measurement-surface gate. */
export function filterForwardInventory<T extends { sourceVersion: string | null }>(
  rows: T[],
): T[] {
  return rows.filter((r) => r.sourceVersion === SOURCE_VERSION_V2);
}

/** Telemetry helper: how many legacy rows a measurement pool dropped —
 *  surfaced so a gauge can prove it is forward-only instead of silently
 *  narrowing. */
export function forwardInventorySplit<T extends { sourceVersion: string | null }>(
  rows: T[],
): { forward: T[]; legacyDropped: number } {
  const forward = filterForwardInventory(rows);
  return { forward, legacyDropped: rows.length - forward.length };
}
