// M6 — Gmail inbound → Verification_Notes append (mirrors quo-sync). @agent: outreach
//
// THE GMAIL GAP (M6 Part 0): getThreadsForEmail fetches agent email replies
// only ephemerally for gate classification — they were NEVER written to the
// record (no Gmail equivalent of quo-sync). This is that equivalent: append
// verbatim INBOUND email (from != our own address) to the notes blob,
// idempotent by Gmail message id, so the dossier/timeline reads email replies
// the same way it reads SMS. PURE — no I/O.

import { detectL3DollarAmounts, type DollarAmount } from "@/lib/outreach/l3-amount-detector";
import { extractEmailAddress } from "./match";

export interface GmailSyncInputMessage {
  id: string;
  from: string;
  body: string;
  /** ISO date. */
  date: string;
}

export interface GmailSyncEvent {
  id: string;
  body: string;
  date: string;
  amounts: DollarAmount[];
}

export interface GmailSyncResult {
  notes: string;
  newEvents: GmailSyncEvent[];
  skippedAlreadyPresent: string[];
  escalationCount: number;
}

const GMAIL_MARKER_RE = /\[Gmail inbound msg ([A-Za-z0-9_-]+)/g;

/** Pure: extract every Gmail message id already cited in the notes blob. */
export function extractCitedGmailIds(notes: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!notes) return ids;
  let m: RegExpExecArray | null;
  const re = new RegExp(GMAIL_MARKER_RE.source, GMAIL_MARKER_RE.flags);
  while ((m = re.exec(notes)) != null) ids.add(m[1]);
  return ids;
}

/** Pure: append verbatim INBOUND email replies to the notes blob, idempotent
 *  by Gmail id. Our own sent messages (from === ourAddress) are skipped. */
export function appendGmailMessagesToNotes(
  existingNotes: string | null | undefined,
  messages: GmailSyncInputMessage[],
  ourAddress: string,
  opts: { nowIso?: string; syncMarkerSource?: string } = {},
): GmailSyncResult {
  const source = opts.syncMarkerSource ?? "gmail_sync";
  const ingestedAt = opts.nowIso ?? new Date().toISOString();
  const our = extractEmailAddress(ourAddress);
  const cited = extractCitedGmailIds(existingNotes);
  const skippedAlreadyPresent: string[] = [];
  const newEvents: GmailSyncEvent[] = [];

  for (const m of messages) {
    if (!m.id || !m.body || !m.body.trim()) continue;
    if (our && extractEmailAddress(m.from) === our) continue; // our own sent message
    if (cited.has(m.id)) {
      skippedAlreadyPresent.push(m.id);
      continue;
    }
    newEvents.push({ id: m.id, body: m.body, date: m.date, amounts: detectL3DollarAmounts(m.body).amounts });
  }

  if (newEvents.length === 0) {
    return { notes: existingNotes ?? "", newEvents, skippedAlreadyPresent, escalationCount: 0 };
  }

  const blocks = [...newEvents]
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .map((e) => {
      const dollarTag =
        e.amounts.length > 0
          ? ` ⚠ ESCALATE: ${e.amounts.map((a) => `$${a.amountUsd.toLocaleString()}`).join(", ")}`
          : "";
      const mm = e.date.match(/(\d{4})-(\d{2})-(\d{2})/);
      const md = mm ? `${parseInt(mm[2], 10)}/${parseInt(mm[3], 10)}` : e.date.slice(0, 10);
      return [
        `${md} — EMAIL INBOUND: UNCLASSIFIED. Body: ${e.body}`,
        `[Gmail inbound msg ${e.id} ts=${e.date} src=${source} ingested_at=${ingestedAt}${dollarTag}]`,
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
