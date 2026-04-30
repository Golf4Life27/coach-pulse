// Minimal note-line helpers used by the Action Queue's Response Card detection.
// Step 3 will extend this into a full conversation parser; keep the public
// surface small until then.

export type Direction = "inbound" | "outbound";

const ALEX_RE = /\bALEX:\s*(.+)$/i;
const BODY_RE = /\bBody:\s*(.+)$/i;
const L3_RE = /\bL3:\s*(.+)$/i;

function nonEmptyLines(notes: string | null | undefined): string[] {
  if (!notes) return [];
  return notes.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function latestMessageDirection(
  notes: string | null | undefined,
): Direction | null {
  const lines = nonEmptyLines(notes);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (ALEX_RE.test(line)) return "outbound";
    if (BODY_RE.test(line) || L3_RE.test(line)) return "inbound";
  }
  return null;
}

export function lastInboundLine(
  notes: string | null | undefined,
): string | null {
  const lines = nonEmptyLines(notes);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const body = line.match(BODY_RE);
    if (body) return body[1].trim();
    const l3 = line.match(L3_RE);
    if (l3) return l3[1].trim();
  }
  return null;
}

export function lastOutboundLine(
  notes: string | null | undefined,
): string | null {
  const lines = nonEmptyLines(notes);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(ALEX_RE);
    if (m) return m[1].trim();
  }
  return null;
}
