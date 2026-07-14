// Shared conveyor source fetch — the ONE place the decision feed's raw inputs
// are pulled + normalized, so every surface that ranks them (the Act Now
// conveyor AND the proactive Maverick dock) reads identical data and can never
// drift. Client-safe: fetch + shape only, no React, no secrets.
//
// Per-source fail-soft: a transient failure returns null for THAT source so the
// caller keeps its prior data (the feed never flickers to empty on one bad
// poll) — preserving ConveyorFeed's original Promise.allSettled behavior.

import type { ProposalRow, ActionItemRow, PriorityRow, BroCardRow } from "@/lib/conveyor/model";

export interface FastSources {
  /** null = this source failed this poll; keep whatever you had. */
  proposals: ProposalRow[] | null;
  actionItems: ActionItemRow[] | null;
  priorities: PriorityRow[] | null;
}

/** The three fast sources (Pending proposals, operator action items, curated
 *  priorities). Each resolves independently; a failure is null, not []. */
export async function fetchFastSources(): Promise<FastSources> {
  const [p, a, pr] = await Promise.allSettled([
    fetch("/api/proposals").then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
    fetch("/api/operator-actions").then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
    fetch("/api/maverick/priorities", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
  ]);
  return {
    proposals: p.status === "fulfilled" && Array.isArray(p.value) ? (p.value as ProposalRow[]) : null,
    actionItems: a.status === "fulfilled" ? ((a.value.items as ActionItemRow[]) ?? []) : null,
    priorities: pr.status === "fulfilled" ? ((pr.value.actions as PriorityRow[]) ?? []) : null,
  };
}

/** The async brief (LLM pass) that yields Act Now "look at this deal" cards.
 *  null on any failure — it is progressive enhancement; the fast feed stands
 *  alone. */
export async function fetchBriefCards(): Promise<BroCardRow[] | null> {
  try {
    const res = await fetch("/api/jarvis-brief");
    if (!res.ok) return null;
    const data = await res.json();
    const cards = Array.isArray(data.broCards) ? data.broCards : [];
    return cards
      .filter((c: Record<string, unknown>) => typeof c.recordId === "string")
      .map((c: Record<string, unknown>) => ({
        recordId: c.recordId as string,
        address: (c.address as string) ?? "",
        headline: (c.headline as string) ?? "",
        why_this_matters: (c.why_this_matters as string) ?? "",
      }));
  } catch {
    return null;
  }
}
