// Freshest-activity-first ordering for the quo-reconcile phone pool
// (backstop-starvation fix, 2026-07-27). Mirrors scan-comms' per-listing
// sort (2026-07-13) but scoped to a phone: a phone's freshness is the
// MOST RECENT Last_Inbound_At / Last_Outbound_At across every listing
// sharing it, so a live conversation always sorts ahead of a stale
// Texted backlog even when several listings share one agent phone.
//
// Feeds lib/admin/rehab-sweep-cursor.ts's rotating cursor: sorted order
// decides who's "freshest" within a cap-sized window, the cursor decides
// which window this run gets.

import type { CursorCandidate } from "@/lib/admin/rehab-sweep-cursor";

export interface PhoneActivityListing {
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
}

export interface PhoneCandidate extends CursorCandidate {
  freshestAt: number;
}

/** Pure: freshest-activity-first ordering of a phone → listings pool. */
export function sortPhonesByFreshness(
  phoneToListings: Map<string, PhoneActivityListing[]>,
): PhoneCandidate[] {
  return [...phoneToListings.entries()]
    .map(([phone, listings]) => ({
      id: phone,
      freshestAt: listings.reduce(
        (max, l) => Math.max(max, Date.parse(l.lastInboundAt ?? "") || 0, Date.parse(l.lastOutboundAt ?? "") || 0),
        0,
      ),
    }))
    .sort((a, b) => b.freshestAt - a.freshestAt);
}
