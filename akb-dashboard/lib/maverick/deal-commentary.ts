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
  /** SMS-attributable outbound send timestamp (Last_Outreach_Date in Airtable). */
  lastOutreachDate: string | null;
  /** Most recent inbound (any channel). */
  lastInboundAt: string | null;
  /** Most recent outbound (any channel — SMS via Quo). */
  lastOutboundAt: string | null;
  /**
   * Phase 11.2 — email-attributable outbound timestamp
   * (Last_Email_Outreach_Date in Airtable). Combined with the other
   * three via max() to compute the actual last-contact instant.
   */
  lastEmailOutreachDate: string | null;
}

/**
 * Phase 11.2 — true "last contact" instant across SMS + email + inbound.
 * Replaces the prior fallback-chain semantics (`a ?? b ?? c`) which
 * could pick an OLDER timestamp when a newer one existed on a different
 * field. Returns the most recent parseable ISO across all four inputs,
 * or null when none are parseable. Pure.
 *
 * Test cases that drove this fix:
 *   - SMS-only history: returns lastOutreachDate (unchanged behavior)
 *   - Email-only history: returns lastEmailOutreachDate (was null pre-fix)
 *   - Mixed history, SMS newer: returns SMS date
 *   - Mixed history, email newer (the 23 Fields case): returns email date
 *   - All null: returns null (caller falls back to created-at elsewhere)
 */
export function latestContactIso(listing: DealCommentaryListing): string | null {
  const candidates = [
    listing.lastInboundAt,
    listing.lastOutboundAt,
    listing.lastOutreachDate,
    listing.lastEmailOutreachDate,
  ];
  let bestIso: string | null = null;
  let bestMs = -Infinity;
  for (const iso of candidates) {
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (isNaN(t)) continue;
    if (t > bestMs) {
      bestMs = t;
      bestIso = iso;
    }
  }
  return bestIso;
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
    // Phase 11.2 — true most-recent contact across SMS + email + inbound.
    // The prior fallback-chain semantics surfaced false-stale on active
    // email negotiations (23 Fields). max() across all four fixes it.
    const lastTouchIso = latestContactIso(listing);
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
