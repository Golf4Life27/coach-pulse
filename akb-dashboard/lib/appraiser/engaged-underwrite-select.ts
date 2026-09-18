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
import { arvStampTrusted } from "@/lib/arv-epoch";

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
  // Epoch gate: a stamp from before the sold-comps-only engine (#126) is
  // contaminated output, not a fresh underwrite — re-run it.
  if (!arvStampTrusted(raw)) return false;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= maxAgeDays * 86_400_000;
}

/** Selection order (2026-09-18, the Harrison St / Ocala class): a live
 *  counter is the hottest money on the board — it has a number attached and
 *  a clock running — so it must be underwritten before a plain Negotiating
 *  or Response Received record even when the latter is more recently
 *  active. Offer Accepted sits last: the price fight is over, underwriting
 *  there is a contract-prep formality, not a negotiation input. */
const STATUS_ORDER: Record<string, number> = {
  "Counter Received": 0,
  Negotiating: 1,
  "Response Received": 2,
  "Offer Accepted": 3,
};

/** Freshest of the timestamps the Listing type actually carries for "when
 *  did this deal last move" — lastInboundAt (their reply), lastOutboundAt
 *  (our reply), and replyClassifiedAt (the triage stamp on the latest
 *  inbound, which can lead lastInboundAt when a backfill or reclassify
 *  touches it). No single field is authoritative; the record's WORK is. */
function engagedAt(l: Pick<Listing, "lastInboundAt" | "lastOutboundAt" | "replyClassifiedAt">): number {
  const candidates = [l.lastInboundAt, l.lastOutboundAt, l.replyClassifiedAt]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t));
  return candidates.length ? Math.max(...candidates) : 0;
}

export interface EngagedTarget {
  id: string;
  address: string | null;
  status: string;
  lastActivityAt: string | null;
}

/** Retry backoff for a target whose last attempt FAILED to produce data
 *  (Decision_Verdict=NEEDS_DATA stamped after the record's last activity).
 *  Without this, a record whose address RentCast can't resolve sits at the
 *  top of the newest-first queue and burns the whole bounded run every tick
 *  — starving everything behind it (2026-07-13 discovery: the 14:25 run's
 *  budget went to nobody). New inbound/outbound activity clears the backoff
 *  immediately — a live counter always re-attempts. */
export const NEEDS_DATA_RETRY_BACKOFF_H = 20;

/** Pure: true when the record's last underwrite attempt failed AFTER its
 *  latest activity and within the backoff window — skip it this run. */
export function inNeedsDataBackoff(
  l: Pick<Listing, "decisionVerdict" | "decisionComputedAt" | "lastInboundAt" | "lastOutboundAt">,
  now: Date,
  backoffHours: number = NEEDS_DATA_RETRY_BACKOFF_H,
): boolean {
  if (l.decisionVerdict !== "NEEDS_DATA" || !l.decisionComputedAt) return false;
  // A NEEDS_DATA computed before the engine epoch was judged on contaminated
  // inputs — it must not gate the fixed engine's first attempt.
  if (!arvStampTrusted(l.decisionComputedAt)) return false;
  const computed = Date.parse(l.decisionComputedAt);
  if (!Number.isFinite(computed)) return false;
  if (now.getTime() - computed > backoffHours * 3_600_000) return false; // backoff expired
  const lastActivity = Math.max(
    l.lastInboundAt ? Date.parse(l.lastInboundAt) : 0,
    l.lastOutboundAt ? Date.parse(l.lastOutboundAt) : 0,
  );
  // Fresh activity since the failed attempt → re-attempt now.
  return lastActivity <= computed;
}

/** Pure: the engaged, Auto-Proceed, stale-underwrite cohort — ordered
 *  Counter Received > Negotiating > Response Received > Offer Accepted
 *  (STATUS_ORDER above), and within a status, most recently engaged first
 *  (engagedAt above) — so a bounded run does the hottest deals. Records in
 *  NEEDS_DATA retry backoff are excluded so one unresolvable address can't
 *  starve the queue. Returns full listings so the route can pass them
 *  straight to compute. */
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
        !underwriteFresh(l, now, maxAgeDays) &&
        !inNeedsDataBackoff(l, now),
    )
    .sort((a, b) => {
      const sa = STATUS_ORDER[a.outreachStatus ?? ""] ?? 99;
      const sb = STATUS_ORDER[b.outreachStatus ?? ""] ?? 99;
      if (sa !== sb) return sa - sb;
      return engagedAt(b) - engagedAt(a);
    });
}
