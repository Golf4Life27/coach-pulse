// Conversation parser for the Notes field on Listings_V1.
//
// Speaker prefixes (per the handoff spec):
//   "ALEX:"          → outbound (Alex's manual reply, written by L4)
//   "L3:" or "Body:" → inbound (agent reply, captured by L3)
//   anything else    → system row (e.g. "Automated text sent via Quo...")
//
// Lines without a recognised timestamp prefix are treated as continuations of
// the previous parsed entry; if there is no previous entry, they become a
// single null-timestamp system row.

export type Direction = "inbound" | "outbound";
export type EntryType = "outbound" | "inbound" | "system";
export type Speaker = "ALEX" | "L3" | "Body" | null;

export interface ConversationEntry {
  timestamp: string | null;
  speaker: Speaker;
  type: EntryType;
  text: string;
}

// Matches "M/D h:MMam — ", "M/D — ", "M/D/YYYY h:MM pm — " etc. Accepts
// em-dash, en-dash, or plain hyphen as the separator.
const TIMESTAMP_RE =
  /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+\d{1,2}:\d{2}\s*[ap]m)?)\s*[—–-]\s*(.*)$/i;

const ALEX_RE = /^ALEX:\s*(.*)$/i;
const BODY_RE = /Body:\s*(.+)$/i;
const L3_RE = /L3:\s*(.+)$/i;

function classifyContent(content: string): {
  type: EntryType;
  speaker: Speaker;
  text: string;
} {
  const alex = content.match(ALEX_RE);
  if (alex) return { type: "outbound", speaker: "ALEX", text: alex[1].trim() };

  // Prefer Body: extraction since the spec format combines L3 and Body on the
  // same line ("L3: INTEREST. Body: <message>") and Body is the actual reply.
  const body = content.match(BODY_RE);
  if (body) return { type: "inbound", speaker: "Body", text: body[1].trim() };

  const l3 = content.match(L3_RE);
  if (l3) return { type: "inbound", speaker: "L3", text: l3[1].trim() };

  return { type: "system", speaker: null, text: content.trim() };
}

export function parseConversation(
  notes: string | null | undefined,
): ConversationEntry[] {
  if (!notes) return [];
  const lines = notes.split("\n").map((l) => l.trim()).filter(Boolean);
  const entries: ConversationEntry[] = [];

  for (const line of lines) {
    const m = line.match(TIMESTAMP_RE);
    if (m) {
      const [, timestamp, content] = m;
      entries.push({ timestamp, ...classifyContent(content) });
      continue;
    }
    // Continuation line — append to previous entry's text. If there's no
    // previous entry, treat the orphan line as a null-timestamp row.
    const last = entries[entries.length - 1];
    if (last) {
      last.text = last.text ? `${last.text}\n${line}` : line;
    } else {
      entries.push({ timestamp: null, ...classifyContent(line) });
    }
  }

  return entries;
}

export function latestMessageDirection(
  notes: string | null | undefined,
): Direction | null {
  const entries = parseConversation(notes);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "outbound") return "outbound";
    if (entries[i].type === "inbound") return "inbound";
  }
  return null;
}

function isGarbageLine(text: string): boolean {
  if (text.length < 5) return true;
  if (/^\d+$/.test(text.trim())) return true;
  if (/\btest\b/i.test(text)) return true;
  return false;
}

export function lastInboundLine(
  notes: string | null | undefined,
): string | null {
  const entries = parseConversation(notes);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "inbound" && !isGarbageLine(entries[i].text))
      return entries[i].text;
  }
  return null;
}

export function lastOutboundLine(
  notes: string | null | undefined,
): string | null {
  const entries = parseConversation(notes);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "outbound" && !isGarbageLine(entries[i].text))
      return entries[i].text;
  }
  return null;
}
