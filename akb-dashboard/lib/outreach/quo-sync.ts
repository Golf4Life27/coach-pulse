// Quo → Verification_Notes sync — append verbatim inbound, idempotent.
// @agent: outreach
//
// THE PROBLEM (6/5 + 5/29 fixtures): three live Quo replies (Burwood,
// Silverage, Waverly) were INVISIBLE to the dossier because they lived
// in OpenPhone but never landed in the source record's Verification_
// Notes. The dossier reads from notes, so the L3 amount detector ran on
// an empty body and missed the negotiation point.
//
// THIS LIB (pure, no I/O) is the append layer:
//
//   1. Extract the set of Quo message ids already cited in the notes
//      (outbound sends marker `Quo msg ACxxxx:` + inbound sync marker
//      `[Quo inbound msg ACxxxx`).
//   2. For each fetched inbound message, append a verbatim entry with
//      its id + timestamp marker, ONLY if the id isn't already cited.
//   3. Return {appended_notes, new_events, escalations} so the caller
//      writes the notes + raises L3-amount escalations.
//
// Idempotent by Quo id — re-running the sync produces zero new appends.

import { detectL3DollarAmounts, type DollarAmount } from "./l3-amount-detector";

export interface QuoSyncInputMessage {
  /** Quo (OpenPhone) message id. */
  id: string;
  /** Verbatim body. */
  body: string;
  /** ISO timestamp. */
  createdAt: string;
  /** "incoming" | "outgoing". The sync only appends inbound. */
  direction: "incoming" | "outgoing";
}

export interface QuoSyncEvent {
  id: string;
  body: string;
  createdAt: string;
  /** Dollar amounts detected in the body. */
  amounts: DollarAmount[];
}

export interface QuoSyncResult {
  /** Updated Verification_Notes (existing + verbatim appended events). */
  notes: string;
  /** Newly-appended events (incoming only). */
  newEvents: QuoSyncEvent[];
  /** Quo ids already cited; we skipped these. */
  skippedAlreadyPresent: string[];
  /** Escalation count — any new event with at least one dollar amount. */
  escalationCount: number;
}

const QUO_ID_RE = /\bAC[a-zA-Z0-9]{14,}\b/g;

/** Pure: extract every Quo message id already cited in the notes blob. */
export function extractCitedQuoIds(notes: string | null | undefined): Set<string> {
  if (!notes) return new Set();
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(QUO_ID_RE.source, QUO_ID_RE.flags);
  while ((m = re.exec(notes)) != null) ids.add(m[0]);
  return ids;
}

/** Pure: append verbatim inbound messages to the notes blob, idempotent
 *  by Quo id. Outbound messages are skipped (the sender already wrote
 *  them at H2 time). */
export function appendQuoMessagesToNotes(
  existingNotes: string | null | undefined,
  messages: QuoSyncInputMessage[],
  opts: { syncMarkerSource?: string; nowIso?: string } = {},
): QuoSyncResult {
  const source = opts.syncMarkerSource ?? "quo_sync";
  const ingestedAt = opts.nowIso ?? new Date().toISOString();
  const cited = extractCitedQuoIds(existingNotes);
  const skippedAlreadyPresent: string[] = [];
  const newEvents: QuoSyncEvent[] = [];

  for (const msg of messages) {
    if (msg.direction !== "incoming") continue;
    if (!msg.id || !msg.body) continue;
    if (cited.has(msg.id)) {
      skippedAlreadyPresent.push(msg.id);
      continue;
    }
    const detection = detectL3DollarAmounts(msg.body);
    newEvents.push({
      id: msg.id,
      body: msg.body,
      createdAt: msg.createdAt,
      amounts: detection.amounts,
    });
  }

  if (newEvents.length === 0) {
    return {
      notes: existingNotes ?? "",
      newEvents,
      skippedAlreadyPresent,
      escalationCount: 0,
    };
  }

  // Build the appended block — most-recent FIRST in the block for the
  // human eye, but each block has its own ISO timestamp so the dossier
  // extractor can reorder canonically.
  const blocks = [...newEvents]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((e) => {
      const dollarTag = e.amounts.length > 0
        ? ` ⚠ ESCALATE: ${e.amounts.map((a) => `$${a.amountUsd.toLocaleString()}`).join(", ")}`
        : "";
      const dateTag = e.createdAt.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? e.createdAt.slice(0, 10);
      const monthDay = dateTag.match(/(\d{4})-(\d{2})-(\d{2})/);
      const md = monthDay ? `${parseInt(monthDay[2], 10)}/${parseInt(monthDay[3], 10)}` : dateTag;
      return [
        `${md} — L3 INBOUND: UNCLASSIFIED. Body: ${e.body}`,
        `[Quo inbound msg ${e.id} ts=${e.createdAt} src=${source} ingested_at=${ingestedAt}${dollarTag}]`,
      ].join("\n");
    });

  const sep = (existingNotes ?? "").trim().length > 0 ? "\n\n" : "";
  const notes = `${(existingNotes ?? "").replace(/\s+$/u, "")}${sep}${blocks.join("\n\n")}`;
  return {
    notes,
    newEvents,
    skippedAlreadyPresent,
    escalationCount: newEvents.filter((e) => e.amounts.length > 0).length,
  };
}
