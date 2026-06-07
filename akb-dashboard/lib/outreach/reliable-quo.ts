// Quo reliable-fetch + duplicate-send guard — replaces the lossy feed walk.
// @agent: outreach
//
// THE FAILURE THIS LIB FIXES (operator brief, 2026-06-07):
//   • getMessagesForParticipant was lossy — failed to surface both
//     delivered 6/7 outbounds across repeated pulls, ignored the
//     participant filter, inconsistent windowing.
//   • The "phantom send" was a false alarm — send was real, READER LIED.
//
// THE STANDING RULE (pinned by test below):
//   No send is marked "sent" until it has been FETCHED BACK and SEEN
//   via a reliable per-ID lookup. Pre-confirmation, status is
//   "attempted_unconfirmed".
//
// THE DUPLICATE-SEND GUARD (separate fix):
//   A manual duplicate slipped through today. Make duplicates
//   structurally impossible: before any send, look up the thread's last
//   outbound by participant. If the body matches AND was sent within the
//   dup-window, refuse with "duplicate_within_window".
//
// Pure. No I/O. The caller (route or sender) owns the fetch + decision.

import type { QuoMessage } from "@/lib/quo";

export type ReliableSendVerdict =
  | "confirmed_sent"            // POST 2xx + per-ID lookup found the row
  | "attempted_unconfirmed"     // POST 2xx but per-ID lookup did NOT find
  | "send_failed";              // POST non-2xx OR threw

export interface ReliableSendInputs {
  postOk: boolean;
  /** The queued message id from the POST response. */
  postedId: string | null;
  /** Reliable per-ID lookup result. null = lookup failed / not seen. */
  fetchedById: { id: string; body: string; createdAt: string; direction: "incoming" | "outgoing" } | null;
  /** The body we POSTed — for verification against the lookup. */
  intendedBody: string;
}

export interface ReliableSendResult {
  verdict: ReliableSendVerdict;
  reason: string;
}

/** Pure: decide whether a send is truly confirmed. The POST being 2xx is
 *  NOT enough — the reader must ALSO see the queued row at the per-ID
 *  endpoint AND the body must match. */
export function reliableSendVerdict(input: ReliableSendInputs): ReliableSendResult {
  if (!input.postOk) {
    return { verdict: "send_failed", reason: "POST /v1/messages did not return 2xx" };
  }
  if (!input.postedId) {
    return { verdict: "attempted_unconfirmed", reason: "POST 2xx but no message id returned — cannot lookup" };
  }
  if (!input.fetchedById) {
    return {
      verdict: "attempted_unconfirmed",
      reason: `POST 2xx (id=${input.postedId}) but per-ID lookup did NOT see the row — feed-walk would silently drop this`,
    };
  }
  if (input.fetchedById.id !== input.postedId) {
    return {
      verdict: "attempted_unconfirmed",
      reason: `lookup returned a different id (${input.fetchedById.id}) than the POST queued (${input.postedId})`,
    };
  }
  if (input.fetchedById.body.trim() !== input.intendedBody.trim()) {
    return {
      verdict: "attempted_unconfirmed",
      reason: `lookup body diverges from intended body — possible truncation or charset issue`,
    };
  }
  return { verdict: "confirmed_sent", reason: `confirmed via per-ID lookup (id=${input.postedId})` };
}

// ── Duplicate-send guard ──────────────────────────────────────────────

export const DUP_WINDOW_HOURS_DEFAULT = 24;

export type DupGuardVerdict = "send_allowed" | "duplicate_within_window";

export interface DupGuardInputs {
  /** Recent outbound messages in the thread, most-recent first. The
   *  caller's job is to ensure these are RELIABLY fetched (lookup-by-ID
   *  for each, or per-thread lookup that's verified). */
  recentOutbound: Array<{ body: string; createdAt: string }>;
  /** The body we're about to POST. */
  intendedBody: string;
  /** Current evaluation time. */
  now?: Date;
  /** Duplicate window — sends within this window with identical body refuse. */
  windowHours?: number;
}

export interface DupGuardResult {
  verdict: DupGuardVerdict;
  /** When duplicate: the matched prior message details. */
  matchedPrior?: { body: string; createdAt: string; ageHours: number };
  reason: string;
}

function normalizeBody(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Pure: refuse a send if an identical (whitespace-normalized) body went
 *  out within the dup window. Identity is case-insensitive + collapses
 *  whitespace — Quo sometimes mangles whitespace; the LITERAL string match
 *  would miss obvious duplicates. */
export function checkDuplicateSend(input: DupGuardInputs): DupGuardResult {
  const now = input.now ?? new Date();
  const windowMs = (input.windowHours ?? DUP_WINDOW_HOURS_DEFAULT) * 3_600_000;
  const target = normalizeBody(input.intendedBody);
  if (!target) {
    return { verdict: "send_allowed", reason: "empty body — no duplicate possible" };
  }
  for (const m of input.recentOutbound) {
    const t = Date.parse(m.createdAt);
    if (!Number.isFinite(t)) continue;
    const ageMs = now.getTime() - t;
    if (ageMs < 0 || ageMs > windowMs) continue;
    if (normalizeBody(m.body) === target) {
      return {
        verdict: "duplicate_within_window",
        matchedPrior: { body: m.body, createdAt: m.createdAt, ageHours: ageMs / 3_600_000 },
        reason: `identical body sent ${(ageMs / 3_600_000).toFixed(2)}h ago — refusing duplicate`,
      };
    }
  }
  return { verdict: "send_allowed", reason: "no identical-body outbound within window" };
}

// ── Feed-discrepancy detector (operator-described "lossy feed walk") ──
// When a participant fetch returns a set of messages, the per-ID lookup
// should AGREE on every entry. Pure helper to surface the diff.

export interface FeedDiscrepancyInputs {
  feedMessages: QuoMessage[];
  /** Per-ID lookup results: id → present/body. null entries = missing. */
  lookupResults: Map<string, { body: string } | null>;
}

export interface FeedDiscrepancy {
  /** Ids that the feed returned but the per-ID lookup says don't exist. */
  feedOnlyIds: string[];
  /** Ids where the feed body diverges from the per-ID lookup body. */
  bodyDivergenceIds: string[];
  /** Total feed messages vs how many were confirmed by lookup. */
  confirmedCount: number;
  feedCount: number;
}

export function detectFeedDiscrepancy(input: FeedDiscrepancyInputs): FeedDiscrepancy {
  const feedOnlyIds: string[] = [];
  const bodyDivergenceIds: string[] = [];
  let confirmedCount = 0;
  for (const m of input.feedMessages) {
    const lookup = input.lookupResults.get(m.id);
    if (lookup === undefined) continue;          // not checked
    if (lookup == null) { feedOnlyIds.push(m.id); continue; }
    if (normalizeBody(lookup.body) !== normalizeBody(m.body)) {
      bodyDivergenceIds.push(m.id);
      continue;
    }
    confirmedCount++;
  }
  return { feedOnlyIds, bodyDivergenceIds, confirmedCount, feedCount: input.feedMessages.length };
}
