// Auto-underwrite-on-engaged selection (P1.2, 2026-07-13). @agent: appraiser
//
// The manual "Run ARV / Run rehab" buttons are dead to the operator, and the
// existing inline trigger (scan-replies) fires ONLY on an SMS Texted→Response
// Received transition. So a deal that reaches an engaged stage any OTHER way
// — advanced to Negotiating directly, revived over email, or flipped by hand
// (3123 Sunbeam: v1_legacy, Dead→Negotiating, live with no ARV/rehab) — never
// gets underwritten. This selector is the channel-agnostic catch-all: it
// finds every engaged, Auto-Proceed deal that lacks a fresh underwrite, so a
// cron can compute ARV → rehab → buyer-ceiling with zero operator clicks.
//
// Gates (operator doctrine): only deals PAST the intake math gate
// (Execution_Path = Auto Proceed) that LACK a fresh (<14d) underwrite. Raw
// intake is excluded — 95% of it is unworkable and paying for data on it
// burns the RentCast/ATTOM budget. Freshness dedupe prevents re-spending on
// a record priced yesterday. PURE — the route loads listings + enforces the
// paid-API budget guard.

import type { Listing } from "@/lib/types";

/** Engaged = a live negotiation. The reply justified the credit spend. */
export const ENGAGED_STATUSES: ReadonlySet<string> = new Set([
  "Response Received",
  "Negotiating",
  "Counter Received",
  "Offer Accepted",
]);

export const DEFAULT_UNDERWRITE_MAX_AGE_DAYS = 14;

/** An underwrite is fresh when ARV was validated within the window. ARV is
 *  the anchor compute (rehab + buyer-ceiling derive from it); its stamp is
 *  the dedupe key. No stamp → never underwritten → not fresh. */
export function underwriteFresh(
  l: Pick<Listing, "arvValidatedAt">,
  now: Date,
  maxAgeDays: number = DEFAULT_UNDERWRITE_MAX_AGE_DAYS,
): boolean {
  const raw = l.arvValidatedAt;
  if (!raw) return false;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= maxAgeDays * 86_400_000;
}

export interface EngagedTarget {
  id: string;
  address: string | null;
  status: string;
  lastActivityAt: string | null;
}

/** Pure: the engaged, Auto-Proceed, stale-underwrite cohort — newest activity
 *  first so a bounded run does the hottest deals. Returns full listings so the
 *  route can pass them straight to the compute step. */
export function selectEngagedUnderwriteTargets(
  listings: Listing[],
  now: Date = new Date(),
  maxAgeDays: number = DEFAULT_UNDERWRITE_MAX_AGE_DAYS,
): Listing[] {
  return listings
    .filter(
      (l) =>
        ENGAGED_STATUSES.has(l.outreachStatus ?? "") &&
        (l.executionPath ?? "").trim() === "Auto Proceed" &&
        !underwriteFresh(l, now, maxAgeDays),
    )
    .sort((a, b) => {
      const at = a.lastInboundAt ?? a.lastOutboundAt ?? null;
      const bt = b.lastInboundAt ?? b.lastOutboundAt ?? null;
      return (bt ? new Date(bt).getTime() : 0) - (at ? new Date(at).getTime() : 0);
    });
}
