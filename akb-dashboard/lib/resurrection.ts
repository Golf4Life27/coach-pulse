// Resurrection detection — when an inbound SMS or email arrives on a Dead
// listing AND the content is NOT a rejection, flip the record back to
// "Response Received" so it surfaces in the brief instead of staying
// silently buried.
//
// Used by /api/jarvis-brief Pass 1 (before the candidate pool is sliced)
// so resurrected records get a fair shot at the top-10.

import { updateListingRecord } from "@/lib/airtable";
import type { Listing } from "@/lib/types";

const DEAD_STATUSES = new Set(["Dead", "Walked", "Terminated", "No Response"]);

// Phrases that indicate the inbound is itself a rejection — DON'T resurrect.
const REJECTION_PATTERNS = [
  /\bno\s+thanks?\b/i,
  /\bnot\s+interested\b/i,
  /\bpass\b/i,
  /\bsold\b/i,
  /\bunder\s+contract\b/i,
  /\bstop\b/i,
  /\bremove\s+me\b/i,
  /\bunsubscribe\b/i,
  /\btake\s+me\s+off\b/i,
  /\bdo\s+not\s+(?:contact|call|text)\b/i,
];

export interface ResurrectionResult {
  resurrected: boolean;
  reason?: string;
  inboundSnippet?: string;
}

/**
 * Decide whether a Dead-status listing should be resurrected, based on
 * its currently-available timestamps + last inbound body. Pure function —
 * no side effects.
 */
export function evaluateResurrection(
  listing: Listing,
  lastInboundBody: string | null,
): ResurrectionResult {
  if (!DEAD_STATUSES.has(listing.outreachStatus ?? "")) {
    return { resurrected: false };
  }
  if (!listing.lastInboundAt) {
    return { resurrected: false };
  }
  // Inbound must be more recent than our last outbound (otherwise this is
  // the same Dead state we already classified).
  if (listing.lastOutboundAt && new Date(listing.lastInboundAt) <= new Date(listing.lastOutboundAt)) {
    return { resurrected: false };
  }
  // Empty body → can't safely classify; don't resurrect.
  if (!lastInboundBody || lastInboundBody.length < 4) {
    return { resurrected: false };
  }
  if (REJECTION_PATTERNS.some((p) => p.test(lastInboundBody))) {
    return { resurrected: false, reason: "rejection_language" };
  }
  return {
    resurrected: true,
    reason: "non_rejection_inbound",
    inboundSnippet: lastInboundBody.slice(0, 200),
  };
}

/**
 * Side-effecting resurrection: update Airtable Outreach_Status →
 * Response Received and append an audit note. Best-effort; logs and
 * swallows errors so brief generation isn't blocked.
 */
export async function applyResurrection(
  listing: Listing,
  inboundSnippet: string,
): Promise<void> {
  const today = new Date().toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "2-digit",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  const auditLine = `${today} — System: RESURRECTED from Dead. Inbound: ${inboundSnippet.replace(/\s+/g, " ").slice(0, 240)}`;
  const existingNotes = listing.notes ?? "";
  try {
    await updateListingRecord(listing.id, {
      Outreach_Status: "Response Received",
      Verification_Notes: existingNotes ? `${existingNotes}\n${auditLine}` : auditLine,
    });
  } catch (err) {
    console.error(`[resurrection] update failed for ${listing.id}:`, err);
  }
}
