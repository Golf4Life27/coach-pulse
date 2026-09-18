// DISPO COPY GUARD — the last line of defense against "off-market" ever
// reaching a buyer (operator ruling, Spine recydfR9ZsDNSe0Lr, 2026-09-18).
//
// WHY THIS EXISTS: nearly every AKB deal is an on-market MLS listing that a
// buyer found by searching the address and walked. Calling it "off-market"
// is not just imprecise, it is a claim the buyer can falsify in ten seconds
// by pulling up the listing themselves — which burns trust on the first
// message. The default is to leave market status OUT of buyer copy
// entirely; this module is the backstop for the phrase sneaking back in
// through a future edit, an LLM draft, or a stale template.
//
// Pure functions (findBannedCopy / stripBannedCopy) do no I/O and are safe
// to call anywhere. guardBuyerCopy is the ONE deliberate exception in
// lib/dispo: it fires an audit() write, but ONLY when a hit is found, and
// ONLY outside test — under vitest (NODE_ENV === "test") it throws instead,
// so a banned phrase fails the test suite loudly instead of being silently
// stripped and shipped.

import { audit } from "@/lib/audit-log";

/** One regex per banned pattern, case-insensitive. Order doesn't matter —
 *  findBannedCopy runs all of them and returns every match. */
const BANNED_PATTERNS: RegExp[] = [
  // "off-market", "off market", "offmarket", "#offmarket" — one pattern
  // covers the hyphen, the space, and no separator at all.
  /off[\s-]?market/gi,
  /not on the mls/gi,
  /\bexclusive\b/gi,
  // "you won't find this" / "you wont find this", straight or curly apostrophe.
  /you won['’]?t find this/gi,
];

/** Pure. Returns every substring that matched a banned pattern, in the
 *  order found. Empty array means the text is clean. */
export function findBannedCopy(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of BANNED_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push(m[0]);
      if (m[0].length === 0) re.lastIndex++; // never infinite-loop on a zero-width match
    }
  }
  return hits;
}

/** Collapse the whitespace/punctuation debris a removed phrase leaves
 *  behind — double spaces, a stray space before . or , or !/?, and blank
 *  lines. Deliberately not clever: a leftover "and it's available ."
 *  reads a little awkward and that's fine, it's still true and it's ASCII. */
function tidyWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ +([.,!?])/g, "$1")
    .replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Pure. Removes every banned match from `text` and tidies the leftover
 *  whitespace/punctuation. Returns the cleaned text plus the list of hits
 *  (empty when nothing was found, in which case `text` is returned
 *  unchanged). */
export function stripBannedCopy(text: string): { text: string; hits: string[] } {
  const hits = findBannedCopy(text);
  if (hits.length === 0) return { text, hits };
  let stripped = text;
  for (const pattern of BANNED_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    stripped = stripped.replace(re, "");
  }
  return { text: tidyWhitespace(stripped), hits };
}

/**
 * The gate every buyer-facing string composer calls before returning its
 * output. `surface` names the call site (e.g. "public_deal.headline",
 * "package.sms") for the audit trail / error message. `recordId` is
 * optional context for the audit write.
 *
 * Under vitest (NODE_ENV === "test") a hit THROWS — a banned phrase must
 * fail the test suite, never ship silently. In production a hit is
 * stripped and returned, with a fire-and-forget audit write recording what
 * was caught (this is the one deliberate I/O in lib/dispo, and it only
 * fires when there is something to report).
 */
export function guardBuyerCopy(text: string, surface: string, recordId?: string): string {
  const { text: stripped, hits } = stripBannedCopy(text);
  if (hits.length === 0) return text;

  if (process.env.NODE_ENV === "test") {
    throw new Error(`banned buyer copy on ${surface}: ${hits.join(", ")}`);
  }

  audit({
    agent: "scribe",
    event: "dispo_copy_guard_stripped",
    status: "confirmed_failure",
    recordId,
    inputSummary: { surface, hits },
    outputSummary: { chars_removed: text.length - stripped.length },
  }).catch(() => {});

  return stripped;
}
