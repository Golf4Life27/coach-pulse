// THREAD RECONCILE — turns operator manual Quo-app sends the record's notes
// never saw into the same note format countUnrecordedOutbound already checks
// for ("Quo msg <id> ..."), so a second reconcile run finds zero left to do.
// Pure: the I/O (thread fetch, Airtable read/write) stays in the route
// (app/api/admin/thread-reconcile), which reuses thread-tail's read and
// thread-truth's id parsing. See lib/outreach/thread-truth.ts for why the
// live thread outranks record notes (Canfield incident, Spine
// recJesmOUJXksQ11V) — this is the server-side fix for the manual side of
// that gap: a note text large fields can't be retyped byte-exact by hand.

import type { QuoMessage } from "@/lib/quo";
import { parseKnownQuoIds } from "./thread-truth";

const MAX_BODY_LEN = 200;

/** Collapse embedded newlines/whitespace runs to a single space and cap
 *  length — keeps one Quo message to exactly one note line regardless of
 *  what the operator actually typed. */
function collapseBody(body: string | null | undefined): string {
  return (body ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_BODY_LEN);
}

export interface UnrecordedOutbound {
  id: string;
  createdAt: string;
  body: string;
}

export interface ReconcileResult {
  /** Outgoing thread messages whose id the notes don't know, oldest first. */
  unrecorded: UnrecordedOutbound[];
  /** The full note block to prepend; "" when nothing is unrecorded. */
  block: string;
}

/** Pure: compute which live-thread outbound messages are missing from
 *  `notes` (case-insensitive id match — the same test countUnrecordedOutbound
 *  uses) and build the reconciliation note block for them, oldest first. */
export function buildReconcileBlock(
  messages: readonly QuoMessage[],
  notes: string | null | undefined,
  now: Date,
): ReconcileResult {
  const known = parseKnownQuoIds(notes);
  const unrecorded = messages
    .filter((m) => m.direction === "outgoing" && m.id && !known.has(m.id.toUpperCase()))
    .slice()
    .sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""))
    .map((m) => ({ id: m.id, createdAt: m.createdAt, body: m.body ?? "" }));

  if (unrecorded.length === 0) return { unrecorded, block: "" };

  const header =
    `[Manual Quo outbound reconciled ${now.toISOString()}] ${unrecorded.length} operator text(s) sent by ` +
    `hand from the Quo app were absent from these notes and would trip the send gate ` +
    `(unrecorded_outbound_in_thread). Recorded from the live thread so the gate and the notes agree:`;
  const lines = unrecorded.map((m) => `Quo msg ${m.id} outgoing ${m.createdAt}: ${collapseBody(m.body)}`);
  return { unrecorded, block: [header, ...lines].join("\n") };
}

/** Pure: prepend a reconcile block above existing notes — top of field, a
 *  blank line, then the existing notes unchanged. Empty block = no-op. */
export function prependReconcileBlock(block: string, notes: string | null | undefined): string {
  const existing = notes ?? "";
  if (!block) return existing;
  return existing ? `${block}\n\n${existing}` : block;
}
