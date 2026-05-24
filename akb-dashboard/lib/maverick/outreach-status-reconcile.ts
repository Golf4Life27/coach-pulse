// Phase 11.5 (INV-006) — Outreach_Status auto-transition reconciler.
// @agent: crier (state-machine discipline; aligns with INV-004)
//
// Pure helpers for the daily cron reconciler at
// /api/cron/outreach-status-reconcile. Decides whether a Listings_V1
// record should auto-transition from {Negotiating, Response Received}
// to "Offer Accepted" based on Envelope_ID + idempotency marker in
// Notes.
//
// INV-004 (Spine rec0A9ZWSMMT5Nk9a) added a runtime guard so Crier
// silence signals are suppressed when Envelope_ID is set. INV-006 is
// the cure to INV-004's patch: instead of running a guard at every
// render, transition the status field itself so consumers see correct
// state. INV-004's guard stays in place as belt-and-suspenders for
// the cron-tick reconciliation window (≤24h on the daily Hobby cap).
//
// Operator-override discipline: the idempotency marker in Notes lets
// the cron skip records it already transitioned once. If operator
// subsequently reverts (`walk` → Dead, or manual edit back to
// Negotiating), the cron sees the marker and does not re-transition.
// Operator intent always wins.
//
// Reverse transitions (envelope canceled/expired) are NOT handled
// here; operator uses existing `walk` action. v2 may add reverse
// logic once DocuSign webhook integration lands (Phase 13+).

/** Substring marker appended to Notes when the cron auto-transitions a
 *  record. Future cron runs scan Notes for this marker and skip; this
 *  preserves operator-override after a one-time auto-transition.
 *  Case-insensitive substring match. */
export const RECONCILE_IDEMPOTENCY_MARKER = "auto-transitioned to Offer Accepted";

/** Outreach_Status values the reconciler will transition out of. Any
 *  other state (Texted, Dead, Offer Accepted, etc.) is left alone. */
export const ELIGIBLE_SOURCE_STATES: ReadonlySet<string> = new Set([
  "Negotiating",
  "Response Received",
]);

/** Minimal listing shape the reconciler reads. Mirrors the
 *  DealCommentaryListing pattern from INV-004 — avoids coupling to
 *  lib/types Listing surface for pure-helper testability. */
export interface ReconcileListing {
  envelopeId: string | null;
  outreachStatus: string | null;
  notes: string | null;
}

export interface ReconcileDecision {
  action: "transition" | "skip";
  /** Reason string for audit + summary. Stable identifier per branch. */
  reason:
    | "no_envelope_id"
    | "status_not_eligible"
    | "already_transitioned"
    | "should_transition";
}

/** Pure: decide whether to auto-transition this record. */
export function shouldAutoTransition(listing: ReconcileListing): ReconcileDecision {
  if (!listing.envelopeId || listing.envelopeId.trim() === "") {
    return { action: "skip", reason: "no_envelope_id" };
  }
  if (!listing.outreachStatus || !ELIGIBLE_SOURCE_STATES.has(listing.outreachStatus)) {
    return { action: "skip", reason: "status_not_eligible" };
  }
  if (notesContainMarker(listing.notes)) {
    return { action: "skip", reason: "already_transitioned" };
  }
  return { action: "transition", reason: "should_transition" };
}

/** Pure: case-insensitive substring scan for the idempotency marker.
 *  Null/empty notes return false (a record with no notes has not been
 *  auto-transitioned). */
export function notesContainMarker(notes: string | null): boolean {
  if (!notes) return false;
  return notes.toLowerCase().includes(RECONCILE_IDEMPOTENCY_MARKER.toLowerCase());
}

/** Pure: build the Notes audit line appended on transition. */
export function buildAuditNoteLine(now: Date, envelopeId: string): string {
  const stamp = now.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${stamp} — System: ${RECONCILE_IDEMPOTENCY_MARKER} (Envelope_ID ${envelopeId} detected; INV-006 reconciler).`;
}
