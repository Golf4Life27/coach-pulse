// Timeline timestamp fixups (operator 2026-07-11, Ivy Bend screenshot):
// a hist-sweep inbound note rendered as "5/12/2001" and sorted ABOVE the
// outbound that preceded it — the notes parser read a year-less "5/12"
// date header (JS Date defaults those to 2001) while the note BODY carried
// the true message time in its sync metadata:
//   [Quo inbound msg AC… ts=2026-05-12T18:10:28.212Z src=quo_hist_sweep …]
//
// Rule 1: an embedded ts= is the message's authoritative timestamp — the
//         sync crons stamp it from the carrier record. Always prefer it.
// Rule 2: a parsed timestamp before 2015 is a parse artifact, not a date
//         this business ever operated on — return null (an undated entry
//         is honest; "5/12/2001" is fabricated).
//
// PURE. Applied to notes entries before the merge so ordering self-heals.

const EMBEDDED_TS_RE = /\bts=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/;
const MIN_PLAUSIBLE_YEAR = 2015;

export function fixNoteTimestamp(entry: { text: string; timestamp: string | null }): string | null {
  const m = EMBEDDED_TS_RE.exec(entry.text);
  if (m) return m[1];
  if (entry.timestamp) {
    const t = Date.parse(entry.timestamp);
    if (!Number.isFinite(t)) return null;
    if (new Date(t).getUTCFullYear() < MIN_PLAUSIBLE_YEAR) return null;
  }
  return entry.timestamp;
}
