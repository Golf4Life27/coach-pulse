// THREAD TRUTH — the live Quo thread outranks record notes. @agent: crier
//
// WHY (incident 2026-07-30, 7714 E Canfield / Spine recJesmOUJXksQ11V): the
// operator personally closed a thread with a manual apology sent from the Quo
// app. Manual sends do not ingest into record notes (the quo-sync gap), so the
// record showed an unanswered thread — and a close-out was sent into a
// conversation the operator had already ended, four messages after the agent
// asked "Are you not getting my texts?". Notes are HISTORY; only the live
// thread is send-authority.
//
// THE INVARIANT (enforced in lib/outreach/send-gate.ts):
//   (a) unrecorded_outbound_in_thread — the live thread contains an OUTGOING
//       message the record has no note of (an operator manual send, or any
//       untracked lane). The system does not know what was last said in its
//       own name → it must not speak. Applies to EVERY purpose, replies
//       included: double-answering over the operator is the same failure.
//   (b) unseen_inbound_in_thread — the live thread contains an INCOMING
//       message newer than everything the record knows (ingestion lag or the
//       52-record sync blindspot). An opener-class send would talk over a
//       reply it hasn't read → refuse. Purpose "reply" is exempt from (b)
//       only: a reply is by definition responding to fresh inbound the
//       caller is holding.
//
// PURE evaluator + note-parsing helpers here; the I/O (thread fetch) stays in
// the gate so this file is trivially unit-testable.

import type { QuoMessage } from "@/lib/quo";

/** Quo/OpenPhone message ids as they appear in every recorded send/inbound
 *  note line ("Quo msg AC…", "Quo inbound msg AC…"). */
const QUO_ID_RE = /\bAC[0-9a-f]{30,34}\b/gi;

/** Inbound note markers carry the provider timestamp: "ts=2026-07-30T14:03:35.608Z". */
const NOTE_TS_RE = /\bts=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/g;

/** Clock-skew tolerance between provider timestamps and record stamps. Not an
 *  ingestion grace: an inbound the record hasn't ingested yet is exactly what
 *  rule (b) exists to catch. */
export const THREAD_TRUTH_SKEW_MS = 60_000;

/** Pure: every Quo message id the record's notes know about (sends AND
 *  inbounds — one set; an outgoing thread message missing from it is
 *  unrecorded regardless of which kind of note would have carried it). */
export function parseKnownQuoIds(notes: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!notes) return out;
  for (const m of notes.matchAll(QUO_ID_RE)) out.add(m[0].toUpperCase());
  return out;
}

/** Pure: the newest inbound timestamp the record knows — max of the field
 *  value the caller holds and any ts= markers in the notes (belt and
 *  suspenders: the field lagged the notes more than once). */
export function newestKnownInboundTs(
  lastInboundAtField: string | null | undefined,
  notes: string | null | undefined,
): number | null {
  let max: number | null = null;
  const consider = (iso: string | null | undefined) => {
    if (!iso) return;
    const t = Date.parse(iso);
    if (Number.isFinite(t) && (max == null || t > max)) max = t;
  };
  consider(lastInboundAtField ?? null);
  if (notes) for (const m of notes.matchAll(NOTE_TS_RE)) consider(m[1]);
  return max;
}

export type ThreadTruthReason =
  | "unrecorded_outbound_in_thread"
  | "unseen_inbound_in_thread";

export interface ThreadTruthVerdict {
  ok: boolean;
  reason: ThreadTruthReason | null;
  /** The offending message, for the audit trail. */
  evidence: { id: string; direction: string; createdAt: string; bodyPreview: string } | null;
  /** How many live-thread messages were evaluated. */
  checked: number;
}

/**
 * Pure: compare the LIVE thread tail against what the record knows.
 * `enforceUnseenInbound` is false for purpose "reply" (exemption (b) above).
 */
export function evaluateThreadTruth(opts: {
  thread: QuoMessage[];
  knownQuoIds: ReadonlySet<string>;
  newestKnownInboundMs: number | null;
  enforceUnseenInbound: boolean;
}): ThreadTruthVerdict {
  const { thread, knownQuoIds, newestKnownInboundMs, enforceUnseenInbound } = opts;
  for (const m of thread) {
    const id = (m.id ?? "").toUpperCase();
    if (m.direction === "outgoing") {
      if (id && !knownQuoIds.has(id)) {
        return refuse("unrecorded_outbound_in_thread", m, thread.length);
      }
    } else if (enforceUnseenInbound) {
      const t = Date.parse(m.createdAt ?? "");
      const known = newestKnownInboundMs;
      const unseen =
        Number.isFinite(t) &&
        (known == null || t > known + THREAD_TRUTH_SKEW_MS) &&
        // The id check rescues threads whose inbound WAS noted but whose
        // field/ts markers are absent (oldest ingest formats).
        !(id && knownQuoIds.has(id));
      if (unseen) return refuse("unseen_inbound_in_thread", m, thread.length);
    }
  }
  return { ok: true, reason: null, evidence: null, checked: thread.length };
}

function refuse(reason: ThreadTruthReason, m: QuoMessage, checked: number): ThreadTruthVerdict {
  return {
    ok: false,
    reason,
    evidence: {
      id: m.id,
      direction: m.direction,
      createdAt: m.createdAt,
      bodyPreview: (m.body ?? "").slice(0, 80),
    },
    checked,
  };
}
