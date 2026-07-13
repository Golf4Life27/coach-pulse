// Email body cleaner (P1.3, 2026-07-13). @agent: scribe
//
// Email-sourced conversation entries dumped the ENTIRE quoted thread —
// nested ">" history, "On <date>… wrote:" separators, forwarded-message
// dividers, and trailing signature / IABS / wire-fraud boilerplate — into a
// single bubble. This renders each message as clean per-message content, the
// way the SMS bubbles already read. The RAW body is preserved by the caller
// (notes store it verbatim, and the timeline entry keeps `raw`); this only
// shapes what the panel DISPLAYS.
//
// PURE. Conservative: it keeps everything up to the first quoted-history /
// signature / disclaimer marker, then strips any stray quoted lines. It never
// invents or reorders text.

// Ordered markers that begin quoted history or a signature/disclaimer block.
// The earliest match in the body is the cut point — everything after is
// prior-message history or boilerplate, not this message's content.
const CUT_MARKERS: RegExp[] = [
  /^-{2,}\s*Forwarded message\s*-{2,}/im,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^On\b.{0,200}?\bwrote:\s*$/im, // "On <date>, <name> <email> wrote:"
  /^From:\s.+\n(?:Sent|Date):\s.+/im, // Outlook original-message header block
  /^_{5,}\s*$/m, // Outlook horizontal divider
  /^\s*>+\s?.*$/m, // first inline-quoted line (">")
  /^--\s*$/m, // standard signature delimiter
  /^Sent from my \w+/im, // mobile signature
  /^Click here to book an appointment/im,
  /^\*?\s*Notice:/im,
  /^WIRE FRAUD IS REAL/im,
  /Information About Brokerage Services/i,
  /Consumer Protection Notice/i,
  /^Texas Real Estate Commission\b/im,
  /statute of frauds/i,
  /does not consent to conduct transactions by\s*\n?\s*electronic/i,
];

/** Pure: strip quoted reply history + trailing signature/disclaimer blocks
 *  from an email body, leaving this message's own content. SMS bodies (no
 *  quoting) pass through essentially unchanged. */
export function cleanEmailBody(body: string | null | undefined): string {
  const text = (body ?? "").replace(/\r\n/g, "\n");
  if (!text.trim()) return "";

  let cut = text.length;
  for (const re of CUT_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  let head = text.slice(0, cut);

  // Drop any quoted lines that slipped in before the cut (inline quoting).
  head = head
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");

  // Collapse blank runs and trim — a bubble shouldn't carry trailing air.
  return head.replace(/\n{3,}/g, "\n\n").trim();
}

/** True when cleaning left nothing meaningful (a message that was ONLY quoted
 *  history / boilerplate). Callers may keep such an entry with a placeholder
 *  rather than an empty bubble. */
export function isEmptyAfterClean(body: string | null | undefined): boolean {
  return cleanEmailBody(body).length === 0;
}
