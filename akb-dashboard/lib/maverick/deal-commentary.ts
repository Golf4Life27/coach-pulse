// Maverick deal commentary — per-deal signal inference.
// @agent: maverick (Phase 9.8)
//
// Pure projection: given the shared briefing + a deal's recordId +
// the deal's listing object, derive 0..N commentary signals to render
// on the deal-detail workspace (Daily UX Spec §7.1).
//
// Deterministic by design — Phase 9.8 ships no per-deal Claude calls.
// The synthesis budget is reserved for the briefing-wide narrative
// (one synthesis per briefing, shared across all consumers). Per-deal
// reasoning is rule-based here; richer commentary lands when Pulse
// (Phase 14) provides confidence-scored proactive surfacing.
//
// Empty state ("Maverick is watching this deal") is a deliberate
// non-signal — when no rule fires, the UI renders the watching message
// rather than fabricating content.

import type { StructuredBriefing } from "./briefing";
import type { SeverityTier } from "./severity";
import type { RecentAuditEvent } from "./sources/vercel-kv-audit";

export interface DealCommentarySignal {
  id: string;
  tier: SeverityTier;
  /** Short headline in Maverick voice. */
  headline: string;
  /** Optional reasoning rendered when the card is expanded. */
  reason: string | null;
  /** Roster agent attribution — drives "Crier said…" / "Sentry said…" framing. */
  agent: string | null;
}

/** Minimal listing shape the inferrer needs — avoids tight coupling to lib/types. */
export interface DealCommentaryListing {
  outreachStatus: string | null;
  lastOutreachDate: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
}

const CRIER_SILENCE_TIER_2_DAYS = 14;
const CRIER_SILENCE_TIER_1_DAYS = 7;

/**
 * Project the briefing + listing into a list of commentary signals
 * for the named deal. Returns [] when no rules fire — caller renders
 * the watching empty state.
 */
export function inferDealCommentary(
  briefing: Pick<StructuredBriefing, "audit_summary"> | null,
  recordId: string,
  listing: DealCommentaryListing,
  now: Date = new Date(),
): DealCommentarySignal[] {
  const signals: DealCommentarySignal[] = [];
  const dealEvents = filterEventsForDeal(briefing, recordId);

  // ── Crier silence on Negotiating / Response Received deals.
  if (
    listing.outreachStatus === "Negotiating" ||
    listing.outreachStatus === "Response Received"
  ) {
    const lastTouchIso =
      listing.lastInboundAt ?? listing.lastOutboundAt ?? listing.lastOutreachDate;
    const days = daysSince(lastTouchIso, now);
    if (days != null && days >= CRIER_SILENCE_TIER_2_DAYS) {
      signals.push({
        id: "crier_silence_t2",
        tier: 2,
        headline: `${days} days without contact — this deal is going cold`,
        reason: `Status is ${listing.outreachStatus} but no inbound or outbound activity for ${days} days. Recommend soft-nudge or escalate.`,
        agent: "crier",
      });
    } else if (days != null && days >= CRIER_SILENCE_TIER_1_DAYS) {
      signals.push({
        id: "crier_silence_t1",
        tier: 1,
        headline: `${days} days since last touch`,
        reason: `Last activity ${days} days ago. Watch for staleness; consider follow-up cadence.`,
        agent: "crier",
      });
    }
  }

  // ── Recent failures attributed to this deal.
  const failures = dealEvents.filter((e) => e.status === "confirmed_failure");
  for (const f of failures.slice(0, 2)) {
    signals.push({
      id: `failure_${f.ts}_${f.agent}`,
      tier: 2,
      headline: `${f.agent}/${f.event} failed on this deal`,
      reason: `Failure logged at ${f.ts.slice(0, 19).replace("T", " ")}.`,
      agent: f.agent,
    });
  }

  // ── Recent activity attestation (tier 1 — context, not action).
  if (failures.length === 0 && dealEvents.length > 0) {
    const newest = dealEvents[0];
    signals.push({
      id: "recent_activity",
      tier: 1,
      headline: `${newest.agent} touched this ${daysSince(newest.ts, now) ?? 0}d ago`,
      reason: `Most recent event: ${newest.agent}/${newest.event}.`,
      agent: newest.agent,
    });
  }

  // Sort highest tier first.
  signals.sort((a, b) => b.tier - a.tier);
  return signals;
}

/**
 * Return events from the briefing's recent_events list that are
 * attributed to this recordId. Pure.
 */
export function filterEventsForDeal(
  briefing: Pick<StructuredBriefing, "audit_summary"> | null,
  recordId: string,
): RecentAuditEvent[] {
  if (!briefing) return [];
  return briefing.audit_summary.recent_events.filter(
    (e) => e.recordId === recordId,
  );
}

/**
 * Days between `iso` and `now`, rounded down. Returns null when the
 * timestamp is missing or unparseable. Pure.
 */
function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const delta = now.getTime() - t;
  if (delta < 0) return 0;
  return Math.floor(delta / 86_400_000);
}
